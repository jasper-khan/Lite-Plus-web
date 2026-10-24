export const remoteAgentWaitTimeoutMs = 30_000;

export function setRemoteTerminalInputEnabled(
  terminal: { options: { disableStdin?: boolean } } | null | undefined,
  enabled: boolean,
) {
  if (!terminal) return;
  terminal.options.disableStdin = !enabled;
}

const remoteErrorKeys: Record<string, string> = {
  "Remote control is disabled on this agent": "terminal.session.errors.agent_disabled",
  "Remote session authorization failed": "terminal.session.errors.authorization_failed",
  "Client is offline": "terminal.session.errors.client_offline",
  "Remote control requires an administrator session": "terminal.session.errors.admin_required",
  "Remote session not found": "terminal.session.errors.session_not_found",
  "Remote session ID is required": "terminal.session.errors.session_id_required",
  "Failed to create secure remote session": "terminal.session.errors.secure_session_failed",
  "Remote connection failed": "terminal.session.errors.connection_failed",
  "client is being deleted": "terminal.session.errors.client_deleting",
  "too many active remote sessions": "terminal.session.errors.too_many_sessions",
  "远程会话数量已满，请关闭不用的终端后重试": "terminal.session.errors.too_many_sessions",
  "Agent 版本过旧，请升级": "terminal.session.errors.agent_too_old",
  "节点未启用远程控制": "terminal.session.errors.agent_disabled",
  "站点未启用远程管理": "terminal.session.errors.server_disabled",
  "远程事件队列已满，请稍后重试": "terminal.session.errors.queue_full",
  "remote grant is required": "terminal.session.errors.grant_required",
  "remote grant is invalid": "terminal.session.errors.grant_required",
  "remote grant has expired": "terminal.session.errors.grant_required",
  "remote grant does not match this page": "terminal.session.errors.grant_required",
  "remote grant does not match this login": "terminal.session.errors.grant_required",
  "API keys cannot authorize remote management": "terminal.session.errors.admin_required",
  "administrator password is incorrect": "terminal.session.errors.password_incorrect",
  "administrator password is required": "terminal.session.errors.password_required",
  "2FA code is required": "terminal.session.errors.otp_required",
  "Invalid 2FA code": "terminal.session.invalid_otp",
  "SSO accounts cannot use remote management until they re-authenticate":
    "terminal.session.errors.sso_reauth",
  "too many failed remote authorization attempts": "terminal.session.auth_rate_limited",
  "No clients connected": "exec.errors.noClientsConnected",
  "Command cannot be empty": "exec.errors.emptyCommand",
  "Command is too long": "exec.errors.commandTooLong",
  "clients is required": "exec.errors.noNodes",
};

const fallbacks: Record<string, string> = {
  "terminal.session.connection_failed": "远程连接失败",
  "terminal.session.errors.admin_required": "远程控制需要管理员登录",
  "terminal.session.errors.agent_disabled": "此 Agent 已关闭远程控制",
  "terminal.session.errors.authorization_failed": "远程会话验证失败，请重新连接",
  "terminal.session.errors.client_deleting": "客户端正在删除，暂时无法建立远程连接",
  "terminal.session.errors.client_offline": "客户端当前离线",
  "terminal.session.errors.connection_failed": "远程连接失败",
  "terminal.session.errors.otp_required": "请输入动态口令",
  "terminal.session.errors.password_incorrect": "管理员密码不正确",
  "terminal.session.errors.password_required": "请输入管理员密码",
  "terminal.session.errors.sso_reauth": "SSO 账户需要重新验证后才能使用远程管理",
  "terminal.session.errors.secure_session_failed": "无法创建安全的远程会话",
  "terminal.session.auth_rate_limited": "验证失败次数过多，请稍后再试",
  "terminal.session.invalid_otp": "动态口令无效，请重新输入",
  "terminal.session.errors.session_id_required": "缺少远程会话标识",
  "terminal.session.errors.session_not_found": "远程会话不存在或已失效",
  "terminal.session.errors.terminal_start_failed": "终端启动失败",
  "terminal.session.errors.terminal_start_failed_detail": "终端启动失败：{{detail}}",
  "terminal.session.errors.too_many_sessions": "远程会话数量已满，请关闭不用的终端后重试",
  "terminal.session.errors.agent_too_old": "Agent 版本过旧，请升级",
  "terminal.session.errors.server_disabled": "站点未启用远程管理",
  "terminal.session.errors.queue_full": "远程事件队列已满，请稍后重试",
  "terminal.session.errors.grant_required": "请先完成远程管理重新验证",
  "exec.errors.commandTooLong": "命令过长",
  "exec.errors.emptyCommand": "命令不能为空",
  "exec.errors.noClientsConnected": "所选节点均未连接",
  "exec.errors.noNodes": "请选择至少一个节点",
};

type Translate = (key: string, options?: Record<string, unknown>) => string;

function translate(key: string, options?: Record<string, unknown>, t?: Translate) {
  const template = t ? String(t(key, options)) : (fallbacks[key] ?? key);
  if (t) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ""));
}

const maxRemoteErrorLength = 240;

export function sanitizeRemoteErrorText(text: string): string {
  let output = "";
  for (let index = 0; index < text.length && output.length < maxRemoteErrorLength; index += 1) {
    const code = text.charCodeAt(index);
    if (code === 0x1b) {
      const next = text[index + 1];
      if (next === "[") {
        index += 2;
        while (index < text.length && !/[A-Za-z@]/.test(text[index] ?? "")) index += 1;
        continue;
      }
      if (next === "]") {
        index += 2;
        while (index < text.length) {
          if (text.charCodeAt(index) === 7) break;
          if (text.charCodeAt(index) === 0x1b && text[index + 1] === "\\") {
            index += 1;
            break;
          }
          index += 1;
        }
        continue;
      }
      continue;
    }
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) continue;
    output += text[index] ?? "";
  }
  return output.trim();
}

export function localizeRemoteError(message?: string | null, t?: Translate): string {
  const normalized = sanitizeRemoteErrorText(message ?? "");
  if (!normalized) return translate("terminal.session.connection_failed", undefined, t);

  const key = remoteErrorKeys[normalized];
  if (key) return translate(key, undefined, t);

  const terminalPrefix = "Failed to start terminal:";
  if (normalized.startsWith(terminalPrefix)) {
    const detail = sanitizeRemoteErrorText(normalized.slice(terminalPrefix.length));
    return detail
      ? translate("terminal.session.errors.terminal_start_failed_detail", { detail }, t)
      : translate("terminal.session.errors.terminal_start_failed", undefined, t);
  }

  return normalized;
}

export function captureRotatedRemoteGrant(payload: unknown): {
  grant: string;
  expiresAt: number;
} | null {
  const root =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const nested =
    root?.data && typeof root.data === "object"
      ? (root.data as Record<string, unknown>)
      : null;
  const data = nested ?? root;
  const grant = data?.next_grant;
  if (typeof grant !== "string" || !grant.trim()) return null;
  const expiresAt = Date.parse(String(data?.grant_expires ?? data?.expires_at ?? ""));
  return {
    grant,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

type ReleaseRemoteSession = (sessionID: string) => void;

function requestRemoteSessionRelease(sessionID: string) {
  void fetch("/api/admin/client/remote/session/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session_id: sessionID }),
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => {
    // The WebSocket close path remains a server-side cleanup fallback.
  });
}

export function createRemoteSessionLease(
  sessionID: string,
  releaseRemoteSession: ReleaseRemoteSession = requestRemoteSessionRelease,
) {
  let released = false;
  return {
    sessionID,
    release() {
      if (released) return;
      released = true;
      releaseRemoteSession(sessionID);
    },
  };
}

const remoteGrantStorageKey = "lite.remote-grant";

type StoredRemoteGrant = {
  grant: string;
  expiresAt: number;
  pageID: string;
};

type StoredRemoteGrants = Partial<Record<string, StoredRemoteGrant>>;

let memoryGrants: StoredRemoteGrants = {};

function webStorageSurfaces(): Storage[] {
  const surfaces: Storage[] = [];
  for (const candidate of [
    typeof localStorage === "undefined" ? null : localStorage,
    typeof sessionStorage === "undefined" ? null : sessionStorage,
  ]) {
    if (candidate) surfaces.push(candidate);
  }
  return surfaces;
}

function purgeGrantFromWebStorage() {
  for (const storage of webStorageSurfaces()) {
    try {
      storage.removeItem(remoteGrantStorageKey);
    } catch {
      // Private mode or quota: ignore.
    }
  }
}

purgeGrantFromWebStorage();

export function isRemoteGrantLive(
  grant?: string | null,
  expiresAt?: number | null,
  now = Date.now(),
) {
  return Boolean(grant && expiresAt && expiresAt > now);
}

export function loadStoredRemoteGrant(scope: string): StoredRemoteGrant | null {
  purgeGrantFromWebStorage();
  const stored = memoryGrants[scope];
  if (!stored || !isRemoteGrantLive(stored.grant, stored.expiresAt)) {
    if (stored) delete memoryGrants[scope];
    return null;
  }
  return stored;
}

export function saveStoredRemoteGrant(
  scope: string,
  grant: string,
  expiresAt: number,
  pageID: string,
) {
  purgeGrantFromWebStorage();
  if (!isRemoteGrantLive(grant, expiresAt) || !pageID) {
    clearStoredRemoteGrant(scope);
    return;
  }
  memoryGrants[scope] = { grant, expiresAt, pageID };
}

export function clearStoredRemoteGrant(scope?: string) {
  purgeGrantFromWebStorage();
  if (!scope) {
    memoryGrants = {};
    return;
  }
  delete memoryGrants[scope];
}
