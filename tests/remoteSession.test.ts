import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  captureRotatedRemoteGrant,
  clearStoredRemoteGrant,
  createRemoteSessionLease,
  isRemoteGrantLive,
  loadStoredRemoteGrant,
  localizeRemoteError,
  saveStoredRemoteGrant,
  setRemoteTerminalInputEnabled,
} from "../src/utils/remoteSession.ts";

const terminalSource = readFileSync("src/pages/terminal/RemoteSession.tsx", "utf8");
const terminalCss = readFileSync("src/pages/terminal/Terminal.css", "utf8");

test("rotated grant on session errors is captured without treating it as invalid", () => {
  assert.equal(captureRotatedRemoteGrant(null), null);
  assert.equal(captureRotatedRemoteGrant({ message: "remote grant is invalid" }), null);
  assert.deepEqual(
    captureRotatedRemoteGrant({
      status: "error",
      message: "远程会话数量已满，请关闭不用的终端后重试",
      data: {
        next_grant: "rotated-grant",
        grant_expires: "2026-09-16T12:00:00.000Z",
      },
    }),
    {
      grant: "rotated-grant",
      expiresAt: Date.parse("2026-09-16T12:00:00.000Z"),
    },
  );
  assert.equal(
    localizeRemoteError("远程会话数量已满，请关闭不用的终端后重试", (key) => key),
    "terminal.session.errors.too_many_sessions",
  );
});

test("releases each of three consecutive remote sessions exactly once", () => {
  const released: string[] = [];
  for (const id of ["session-1", "session-2", "session-3"]) {
    const lease = createRemoteSessionLease(id, (sessionID) => released.push(sessionID));
    lease.release();
    lease.release();
  }
  assert.deepEqual(released, ["session-1", "session-2", "session-3"]);
});

test("keeps independent terminal page leases isolated", () => {
  const released: string[] = [];
  const leases = Array.from({ length: 32 }, (_, index) =>
    createRemoteSessionLease(`page-${index}`, (sessionID) => released.push(sessionID)),
  );

  leases[7].release();
  leases[7].release();
  assert.deepEqual(released, ["page-7"]);

  leases.forEach((lease) => lease.release());
  assert.equal(released.length, 32);
  assert.equal(new Set(released).size, 32);
});

test("localizes known server and agent remote errors", () => {
  const cases: Array<[string | undefined, string]> = [
    [undefined, "远程连接失败"],
    ["Remote control is disabled on this agent", "此 Agent 已关闭远程控制"],
    ["Remote session authorization failed", "远程会话验证失败，请重新连接"],
    ["Client is offline", "客户端当前离线"],
    ["Remote session not found", "远程会话不存在或已失效"],
    ["Failed to create secure remote session", "无法创建安全的远程会话"],
    ["client is being deleted", "客户端正在删除，暂时无法建立远程连接"],
    ["administrator password is incorrect", "管理员密码不正确"],
    ["administrator password is required", "请输入管理员密码"],
    ["No clients connected", "所选节点均未连接"],
    ["Command cannot be empty", "命令不能为空"],
    ["Command is too long", "命令过长"],
    ["clients is required", "请选择至少一个节点"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(localizeRemoteError(input), expected);
  }
});

test("uses the caller translator for remote errors", () => {
  const t = (key: string) =>
    key === "terminal.session.errors.client_offline" ? "offline-en" : key;
  assert.equal(localizeRemoteError("Client is offline", t), "offline-en");
  assert.equal(
    localizeRemoteError("No clients connected", (key) =>
      key === "exec.errors.noClientsConnected" ? "所选节点均未连接" : key,
    ),
    "所选节点均未连接",
  );
});

test("keeps unknown remote diagnostics visible", () => {
  assert.equal(localizeRemoteError("custom agent diagnostic"), "custom agent diagnostic");
});

test("strips terminal control sequences from remote error text", () => {
  assert.equal(
    localizeRemoteError("\u001b[31mClient is offline\u001b[0m"),
    "客户端当前离线",
  );
  assert.equal(
    localizeRemoteError("\u001b]52;c;QUFBQQ==\u0007hidden"),
    "hidden",
  );
});

test("mobile terminal input avoids iOS zoom and refits around the keyboard", () => {
  const workspace = readFileSync("src/pages/terminal/index.tsx", "utf8");
  const chrome = readFileSync("src/pages/terminal/remoteChrome.tsx", "utf8");
  assert.match(terminalSource, /inputMode="text"/);
  assert.match(terminalSource, /autoComplete="off"/);
  assert.doesNotMatch(terminalSource, /onFocus=\{resizeTerminal\}/);
  assert.match(terminalSource, /window\.addEventListener\("orientationchange", update\)/);
  assert.match(terminalSource, /helper\.tabIndex = -1/);
  assert.match(terminalSource, /dismissKeyboard/);
  assert.match(terminalSource, /mobileCommandInput\.current\?\.blur\(\)/);
  assert.match(terminalSource, /if \(mobileComposing\.current\) return;/);
  assert.match(terminalSource, /if \(!sendTerminalText\(`\$\{mobileCommand\}\\r`\)\) return;/);
  assert.match(terminalSource, /if \(mobileCommand\) setMobileCommand\(""\);/);
  assert.match(terminalSource, /disabled=\{!remoteReady\}/);
  assert.doesNotMatch(terminalSource, /disabled=\{!remoteReady \|\| !mobileCommand\}/);
  assert.match(terminalSource, /terminal\.session\.send_enter/);
  assert.match(terminalSource, /compactLayout \? 220 : 0/);
  assert.doesNotMatch(terminalSource, /keepFocus/);
  assert.match(workspace, /syncRemoteVisualViewport/);
  assert.match(chrome, /function syncRemoteVisualViewport/);
  assert.match(chrome, /--remote-keyboard-inset/);
  assert.match(terminalCss, /\.terminal-page \.xterm-helper-textarea \{[\s\S]*font-size: 16px !important/);
  assert.match(terminalCss, /\.remote-terminal-pane \{[\s\S]*overflow: hidden/);
  assert.match(terminalCss, /padding-bottom: var\(--remote-keyboard-inset, 0px\)/);
  assert.doesNotMatch(terminalCss, /top: var\(--remote-vv-top, 0px\)/);
  assert.match(chrome, /innerHeight - viewport\.height - viewport\.offsetTop/);
  assert.match(terminalSource, /className="remote-network"/);
  assert.match(terminalSource, /terminal\.session\.cpu_cores/);
  assert.match(terminalSource, /remote-metric-bar/);
  assert.match(terminalSource, /function volumeDetail/);
  assert.match(terminalSource, /remote-metric-slash/);
  assert.match(terminalCss, /\.remote-metric-detail \{[\s\S]*flex-wrap: wrap/);
  assert.match(terminalCss, /\.remote-metric-detail > span \{[\s\S]*white-space: nowrap/);
  assert.match(terminalCss, /\.remote-metric\.has-usage \.remote-metric-bar \{[\s\S]*margin-top: auto/);
  assert.doesNotMatch(terminalCss, /\.remote-metric\.has-usage \.remote-metric-row \{[\s\S]*flex-direction: column/);
  assert.match(terminalCss, /\.remote-metric-detail/);
  assert.match(terminalCss, /\.remote-reconnect \{[\s\S]*color: #d6dfe7/);
  assert.match(terminalCss, /\.remote-reconnect > span \{[\s\S]*color: #d6dfe7/);
  assert.match(terminalCss, /\.remote-metric \{[\s\S]*background-image: none !important/);
  assert.match(terminalCss, /\.remote-metric\.is-up \.remote-metric-row,[\s\S]*margin-top: auto/);
  assert.match(terminalCss, /\.remote-metric\.is-up strong \{[\s\S]*font-size: 24px/);
  assert.match(terminalCss, /\.remote-terminal-head \{[\s\S]*background: transparent/);
  assert.match(terminalCss, /\.remote-terminal-pane \{[\s\S]*border-radius: 12px/);
  assert.match(terminalSource, /if \(percent >= 90\) return "coral"/);
  assert.match(terminalSource, /if \(percent >= 70\) return "amber"/);
  assert.match(terminalCss, /\.remote-metric-bar\.is-coral > i \{[\s\S]*background: #ff6b5e/);
  assert.match(terminalSource, /terminal\.session\.net_up_short/);
  assert.match(terminalSource, /terminal\.session\.net_down_short/);
  assert.match(terminalCss, /\.remote-identity-meta \{[\s\S]*flex-wrap: nowrap/);
  assert.match(terminalCss, /\.remote-network-rule/);
  assert.match(terminalCss, /border-radius: 12px/);
  assert.match(terminalCss, /\.remote-session,[\s\S]*\.remote-session\.has-mobile-panel \{[\s\S]*padding: 0/);
  assert.match(terminalCss, /\.remote-bottom-nav \{[\s\S]*width: 100%/);
  assert.doesNotMatch(terminalCss, /@media \(max-width: 540px\) \{[\s\S]*\.remote-session-actions \{[\s\S]*width: 100%/);
  assert.match(terminalSource, /compactTerminalFontSize = 13/);
  assert.match(terminalSource, /compactTerminalPadding = 6/);
  assert.match(terminalSource, /allowProposedApi: true/);
  assert.match(terminalSource, /attachRemoteTerminalHighlight\(instance\)/);
  assert.match(terminalSource, /remote-identity-address\$\{address === UNREPORTED_ADDRESS \? "" : " is-ip"\}/);
  assert.match(terminalCss, /\.remote-identity-address\.is-ip \{[\s\S]*color: #ff9f43/);
  assert.match(terminalCss, /@media \(max-width: 900px\) \{[\s\S]*\.remote-terminal-head \{[\s\S]*display: none/);
  assert.match(terminalCss, /@media \(max-width: 900px\) \{[\s\S]*--xterm-padding: 6px/);
});

test("mobile terminal drag scrolls terminal history without moving the browser page", () => {
  assert.match(terminalSource, /host\.addEventListener\("touchmove", touchMove, \{ capture: true, passive: false \}\)/);
  assert.match(terminalSource, /instance\.scrollLines\(lines\)/);
  assert.match(terminalSource, /event\.preventDefault\(\)/);
  assert.doesNotMatch(terminalSource, /onPointerMove=/);
  assert.match(
    terminalCss,
    /\.terminal-page\.terminal-xterm-host \{[\s\S]*overscroll-behavior: none;[\s\S]*touch-action: none;/,
  );
  assert.match(terminalCss, /html\.remote-terminal-open body,[\s\S]*overflow: hidden;[\s\S]*overscroll-behavior: none;/);
});

test("file picker checkbox column stays compact and left-aligned", () => {
  assert.match(
    terminalCss,
    /\.remote-file-table th:first-child,[\s\S]*\.remote-file-table td:first-child \{[\s\S]*width: 48px;/,
  );
  assert.match(terminalCss, /\.remote-file-select \{[\s\S]*justify-content: flex-start;/);
  assert.match(terminalCss, /\.remote-file-name \{[\s\S]*display: flex;/);
  assert.match(terminalCss, /\.remote-file-table tbody tr,[\s\S]*border: 0 !important;/);
  assert.match(terminalCss, /--gray-a5: var\(--remote-border\)/);
  assert.doesNotMatch(terminalCss, /\.remote-file-table td:nth-child\(2\) \{[\s\S]*display: flex;/);
  assert.match(terminalCss, /\.remote-file-table th:nth-child\(3\),[\s\S]*width: 80px;/);
  assert.match(terminalCss, /\.remote-file-table th:nth-child\(4\),[\s\S]*width: 128px;/);
});

test("file chrome shares one left inset for path, toolbar, and options", () => {
  assert.match(terminalCss, /--remote-files-inline: 16px;/);
  assert.match(terminalCss, /--remote-file-control-h: 32px;/);
  assert.match(terminalCss, /\.remote-file-up \{/);
  assert.match(terminalCss, /\.remote-file-toolbar \.MuiButton-root svg \{[\s\S]*display: block !important;/);
});

test("desktop remote sessions keep the file sidebar closed until opened", () => {
  assert.match(terminalSource, /useState<SidePanel>\(null\)/);
  assert.doesNotMatch(terminalSource, /innerWidth > 900 \? "files"/);
});

test("remote session no longer treats the Lite host as a protected node", () => {
  assert.doesNotMatch(terminalSource, /remote_control_protected/);
  assert.doesNotMatch(terminalSource, /local_address_blocked/);
});

test("remote terminal stdin is disabled until the session is ready and after it drops", () => {
  const terminal = { options: { disableStdin: false } };
  setRemoteTerminalInputEnabled(terminal, false);
  assert.equal(terminal.options.disableStdin, true);
  setRemoteTerminalInputEnabled(terminal, true);
  assert.equal(terminal.options.disableStdin, false);
  setRemoteTerminalInputEnabled(null, true);
  assert.match(terminalSource, /disableStdin: true/);
  assert.match(terminalSource, /setRemoteTerminalInputEnabled\(terminal\.current, true\)/);
  assert.match(terminalSource, /setRemoteTerminalInputEnabled\(terminal\.current, false\)/);
});

test("remote sessions create terminals through a page-bound rotating grant", () => {
  assert.match(terminalSource, /createSession\(node\.uuid, abortController\.signal\)/);
  assert.doesNotMatch(terminalSource, /2fa_code/);
  assert.doesNotMatch(terminalSource, /otpCode/);
});

test("terminal workspace binds the grant to this page and rotates it per session", () => {
  const workspace = readFileSync("src/pages/terminal/index.tsx", "utf8");
  const cleared = workspace.indexOf('setPasswordInput("");');
  const authorize = workspace.indexOf('fetch("/api/admin/client/remote/authorize"');
  assert.ok(cleared >= 0 && authorize > cleared);
  assert.match(workspace, /page_id: pageIDRef\.current/);
  assert.match(workspace, /captureRotatedRemoteGrant\(payload\)/);
  assert.doesNotMatch(workspace, /remote\/revoke/);
  assert.doesNotMatch(workspace, /pagehide/);
  assert.match(workspace, /loadStoredRemoteGrant\("remote"\)/);
  assert.match(workspace, /saveStoredRemoteGrant\("remote"/);
  assert.doesNotMatch(workspace, /account\?\.sso_type && !twoFaEnabled/);
  assert.match(workspace, /captureRotatedRemoteGrant\(payload\)/);
  assert.match(workspace, /if \(!rotated && \/grant\/i\.test\(message\)\)/);
  assert.match(workspace, /expires_at/);
});

test("login-scoped grant stays in memory and never writes web storage", () => {
  const writes: string[] = [];
  const leftover = new Map<string, string>([["lite.remote-grant", '{"remote":{"grant":"leaked","expiresAt":1}}']]);
  const fakeStorage = {
    getItem(key: string) {
      return leftover.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      writes.push(`${key}=${value}`);
    },
    removeItem(key: string) {
      leftover.delete(key);
    },
  };
  const previousLocal = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousSession = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: fakeStorage,
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: fakeStorage,
  });
  try {
    clearStoredRemoteGrant();
    assert.equal(loadStoredRemoteGrant("remote"), null);
    saveStoredRemoteGrant("remote", "grant-live", Date.now() + 60_000, "page-a");
    assert.equal(loadStoredRemoteGrant("remote")?.grant, "grant-live");
    assert.equal(loadStoredRemoteGrant("remote")?.pageID, "page-a");
    saveStoredRemoteGrant("exec", "grant-exec", Date.now() + 60_000, "page-b");
    clearStoredRemoteGrant("remote");
    assert.equal(loadStoredRemoteGrant("remote"), null);
    assert.equal(loadStoredRemoteGrant("exec")?.grant, "grant-exec");
    saveStoredRemoteGrant("exec", "grant-old", Date.now() - 1, "page-b");
    assert.equal(loadStoredRemoteGrant("exec"), null);
    clearStoredRemoteGrant();
    assert.deepEqual(writes, []);
    assert.equal(leftover.has("lite.remote-grant"), false);
  } finally {
    if (previousLocal) Object.defineProperty(globalThis, "localStorage", previousLocal);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
    if (previousSession) Object.defineProperty(globalThis, "sessionStorage", previousSession);
    else delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  }
});

test("remote reauth is a standalone page until the workspace is entered", () => {
  const workspace = readFileSync("src/pages/terminal/index.tsx", "utf8");
  assert.match(workspace, /AuthStandAlonePage/);
  assert.match(workspace, /if \(authorization === "checking"\)/);
  assert.match(workspace, /if \(!workspaceEntered\)/);
  assert.match(workspace, /remote-terminal-open/);
  assert.match(workspace, /className="remote-workspace"/);
  assert.match(workspace, /open=\{reauthOpen\}/);
  assert.match(workspace, /data-testid="remote-auth-dialog"/);
  assert.match(workspace, /reason === "backdropClick"/);
  assert.match(workspace, /reason === "escapeKeyDown"/);
  assert.match(workspace, /cancelAsText=\{workspaceEntered\}/);
  assert.match(workspace, /width: "auto"/);
  assert.doesNotMatch(workspace, /if \(!authorized\)/);
  assert.doesNotMatch(workspace, /Dialog open=\{authorization === "required"\}/);
});

test("renewing the remote grant does not reconnect mounted sessions", () => {
  const workspace = readFileSync("src/pages/terminal/index.tsx", "utf8");
  const session = readFileSync("src/pages/terminal/RemoteSession.tsx", "utf8");
  assert.doesNotMatch(workspace, /grant=\{/);
  assert.doesNotMatch(session, /grant: string/);
  assert.doesNotMatch(session, /if \(!grant\)/);
  const connectDeps = session.match(/void connect\(\);[\s\S]*?\}, \[([^\]]+)\]/);
  assert.ok(connectDeps, "connect effect dependency list is missing");
  assert.doesNotMatch(connectDeps[1], /\bgrant\b/);
  assert.match(workspace, /grantRef\.current = nextGrant/);
  assert.match(workspace, /saveStoredRemoteGrant\("remote"/);
  assert.match(workspace, /setGrantLive\(true\)/);
  assert.doesNotMatch(workspace, /setReconnectKey/);
  assert.match(workspace, /if \(!isRemoteGrantLive\(grantRef\.current, grantExpiresAtRef\.current\)\) \{\s*setReauthOpen\(true\)/);
});

test("remote auth fields share the login field height", () => {
  const workspace = readFileSync("src/pages/terminal/index.tsx", "utf8");
  const authPage = readFileSync("src/components/admin/shell/AuthStandAlonePage.tsx", "utf8");
  const fields = workspace.slice(
    workspace.indexOf("function RemoteAuthFields"),
    workspace.indexOf("export default function TerminalWorkspace"),
  );
  assert.match(workspace, /authFieldSx/);
  assert.match(authPage, /minHeight: 60/);
  assert.match(fields, /sx=\{authFieldSx\}/);
  assert.doesNotMatch(fields, /size="small"/);
});

test("desktop chrome shows a live session status and appearance segment", () => {
  const workspace = readFileSync("src/pages/terminal/index.tsx", "utf8");
  const chrome = readFileSync("src/components/admin/shell/ChromeActions.tsx", "utf8");
  const commands = readFileSync("src/pages/terminal/CommandClipboard.tsx", "utf8");
  assert.match(workspace, /remote-connected-count/);
  assert.match(workspace, /AppearanceSegment/);
  assert.match(workspace, /ThemeMenu trigger="label"/);
  assert.match(workspace, /terminal\.session\.all_connected/);
  assert.doesNotMatch(workspace, /remote-rail-tip/);
  assert.doesNotMatch(workspace, /terminal\.session\.rail_tip/);
  assert.match(workspace, /<Plus size=\{compact \? 18 : 16\} \/>/);
  assert.doesNotMatch(workspace, /startIcon=\{/);
  assert.match(workspace, /authCancelButtonSx/);
  assert.match(chrome, /remote-theme-segment/);
  assert.match(terminalCss, /\.remote-theme-segment button\.is-active/);
  assert.match(commands, /className="remote-command-card"/);
  assert.match(commands, /flex: "0 0 auto"/);
  assert.match(commands, /remoteConfirmDialogProps/);
  assert.match(terminalCss, /\.remote-confirm-paper \{[\s\S]*background: var\(--remote-paper\)/);
  assert.match(terminalCss, /\.remote-confirm-backdrop \{[\s\S]*backdrop-filter: blur\(8px\)/);
});

test("open remote sessions share one command clipboard", () => {
  const workspace = readFileSync("src/pages/terminal/index.tsx", "utf8");
  const panel = readFileSync("src/pages/terminal/CommandClipboard.tsx", "utf8");
  assert.match(workspace, /CommandClipboardProvider/);
  assert.match(workspace, /<CommandClipboardProvider>/);
  assert.match(panel, /CommandClipboardContent \{\.\.\.props\}/);
  assert.doesNotMatch(panel, /CommandClipboardProvider/);
});

test("auth cancel stays a text action without a hover underline", () => {
  const authPage = readFileSync("src/components/admin/shell/AuthStandAlonePage.tsx", "utf8");
  assert.match(authPage, /authCancelButtonSx/);
  assert.match(authPage, /textDecoration: "none"/);
  assert.doesNotMatch(authPage, /textDecoration: "underline"/);
});

test("remote grant helper never writes localStorage or sessionStorage", () => {
  const source = readFileSync("src/utils/remoteSession.ts", "utf8");
  assert.doesNotMatch(source, /localStorage\.setItem/);
  assert.doesNotMatch(source, /sessionStorage\.setItem/);
  assert.match(source, /storage\.removeItem\(remoteGrantStorageKey\)/);
});

test("remote grant live check treats missing and expired grants as dead", () => {
  assert.equal(isRemoteGrantLive("grant", Date.now() + 60_000), true);
  assert.equal(isRemoteGrantLive("grant", Date.now() - 1), false);
  assert.equal(isRemoteGrantLive("grant", 0), false);
  assert.equal(isRemoteGrantLive("", Date.now() + 60_000), false);
  assert.equal(isRemoteGrantLive("", 0), false);
});
