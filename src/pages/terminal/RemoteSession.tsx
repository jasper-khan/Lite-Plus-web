import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import BottomNavigation from "@mui/material/BottomNavigation";
import BottomNavigationAction from "@mui/material/BottomNavigationAction";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Tab from "@mui/material/Tab";
import Tabs from "@mui/material/Tabs";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import {
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  ClipboardList,
  ClipboardPaste,
  Copy,
  CornerDownLeft,
  KeyboardTab,
  Cpu,
  Files,
  HardDrive,
  MemoryStick,
  MoreHorizontal,
  RotateCw,
  Terminal as TerminalIcon,
  TextSelect,
  PanelRightClose,
} from "@/components/admin/muiIcons";
import { toast } from "sonner";
import type { Record as LiveRecord } from "@/types/LiveData";
import { formatBytes } from "@/utils/unitHelper";
import {
  createRemoteSessionLease,
  localizeRemoteError,
  remoteAgentWaitTimeoutMs,
  setRemoteTerminalInputEnabled,
} from "@/utils/remoteSession";
import { TerminalContext } from "@/contexts/TerminalContext";
import {
  defaultXtermjsSettings,
  isTransparentBackground,
  useXtermjsSettings,
} from "@/hooks/useXtermjsSettings";
import CommandClipboardPanel from "./CommandClipboard";
import FileManager, { type FileManagerHandle } from "./FileManager";
import { attachRemoteTerminalHighlight } from "./remoteTerminalHighlight";
import Flag from "@/components/Flag";
import { usageMetricCardSx } from "@/pages/admin/nodeDetailCardStyles";
import { displayRemoteAddress } from "@/utils/remoteNodePicker";
import { terminalCutControlByte, terminalKeyAction } from "@/utils/terminalCtrl";
import { REMOTE_COMPACT_QUERY, UNREPORTED_ADDRESS, remoteConfirmDialogProps } from "./remoteChrome";
import { useTranslation } from "react-i18next";
import { getAdminMenuProps } from "@/components/admin/adminMenu";

export type RemoteNode = {
  uuid: string;
  name: string;
  ipv4?: string;
  ipv6?: string;
  group?: string;
  tags?: string;
  region?: string;
  region_override?: string;
  cpu_cores?: number;
  mem_total?: number;
  disk_total?: number;
  remote_protocol?: number;
  remote_control_enabled?: boolean;
};

type Props = {
  tabId: string;
  node: RemoteNode;
  live?: LiveRecord;
  online: boolean;
  active: boolean;
  compact: boolean;
  createSession: (uuid: string, signal?: AbortSignal) => Promise<{ session_id: string; browser_ticket: string }>;
  onDuplicate: () => void;
  onConnectionChange?: (tabId: string, state: ConnectionState) => void;
};

export type ConnectionState = "connecting" | "waiting" | "connected" | "disconnected" | "error";
type SidePanel = "files" | "commands" | null;
type ContextMenuState = { x: number; y: number } | null;
type TerminalTouchState = {
  identifier: number;
  startX: number;
  startY: number;
  lastY: number;
  scrollRemainder: number;
  moved: boolean;
};

const compactTerminalQuery = REMOTE_COMPACT_QUERY;
const compactTerminalFontSize = 13;
const compactTerminalPadding = 6;

function percentage(used = 0, total = 0) {
  if (!total) return "0.0%";
  return `${usagePercent(used, total).toFixed(1)}%`;
}

function usagePercent(used = 0, total = 0) {
  if (!total) return 0;
  return Math.min(100, Math.max(0, (used / total) * 100));
}

function usageTone(percent: number) {
  if (percent >= 90) return "coral";
  if (percent >= 70) return "amber";
  return "green";
}

function volumeDetail(used = 0, total = 0) {
  if (!total) return null;
  return (
    <>
      <span>{formatBytes(used)}</span>
      <span className="remote-metric-slash">/ {formatBytes(total)}</span>
    </>
  );
}

function cpuCoreCount(cores: unknown) {
  const value = Number(cores);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(1, Math.round(value));
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through for HTTP origins and browsers that deny the async API.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("clipboard unavailable");
}

function stateLabel(state: ConnectionState, t: (key: string) => string) {
  switch (state) {
    case "connected": return t("terminal.session.connected");
    case "waiting": return t("terminal.session.waiting_agent");
    case "connecting": return t("terminal.session.connecting");
    case "error": return t("terminal.session.connection_failed");
    default: return t("terminal.disconnect");
  }
}

function isPermanentRemoteError(message: string, t: (key: string) => string) {
  const keys = [
    "terminal.session.errors.agent_too_old",
    "terminal.session.errors.agent_disabled",
    "terminal.session.errors.server_disabled",
    "terminal.session.errors.grant_required",
  ];
  return keys.some((key) => message === t(key));
}

function isEditableElement(element: Element | null) {
  return element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable) ||
    Boolean(element?.closest('[role="dialog"]'));
}

export default function RemoteSession({ tabId, node, live, online, active, compact, createSession, onDuplicate, onConnectionChange }: Props) {
  const { t } = useTranslation();
  const { settings, loading: settingsLoading, error: settingsError } = useXtermjsSettings();
  const terminalHost = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal | null>(null);
  const fitAddon = useRef<FitAddon | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const fileManager = useRef<FileManagerHandle>(null);
  const mobileCommandInput = useRef<HTMLInputElement>(null);
  const mobileComposing = useRef(false);
  const terminalTouch = useRef<TerminalTouchState | null>(null);
  const activeRef = useRef(active);
  const [terminalReady, setTerminalReady] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [connectionError, setConnectionError] = useState("");
  const [sidePanel, setSidePanel] = useState<SidePanel>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
  const [sideWidth, setSideWidth] = useState(400);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [remoteReady, setRemoteReady] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>(null);
  const [manualPasteOpen, setManualPasteOpen] = useState(false);
  const [manualPasteText, setManualPasteText] = useState("");
  const [mobileCommand, setMobileCommand] = useState("");
  const remoteReadyRef = useRef(false);
  const dragging = useRef(false);
  const fitTimer = useRef(0);

  activeRef.current = active;

  useEffect(() => {
    onConnectionChange?.(tabId, connectionState);
  }, [connectionState, onConnectionChange, tabId]);

  const resizeTerminal = useCallback(() => {
    if (!activeRef.current) return;
    const compactLayout = window.matchMedia(compactTerminalQuery).matches;
    window.clearTimeout(fitTimer.current);
    fitTimer.current = window.setTimeout(() => {
      fitAddon.current?.fit();
      const term = terminal.current;
      const ws = socket.current;
      if (term && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    }, compactLayout ? 220 : 0);
  }, []);

  const copyTerminalSelection = useCallback(async () => {
    const instance = terminal.current;
    if (!instance?.hasSelection()) {
      toast.info(t("terminal.session.select_content_first"));
      instance?.focus();
      return;
    }
    try {
      await writeClipboardText(instance.getSelection());
      instance.clearSelection();
    } catch {
      toast.error(t("terminal.session.paste_clipboard_denied"));
    } finally {
      instance.focus();
    }
  }, [t]);

  const sendTerminalText = useCallback((text: string) => {
    const ws = socket.current;
    if (!text || ws?.readyState !== WebSocket.OPEN) return false;
    ws.send(new TextEncoder().encode(text.replace(/\r?\n/g, "\r")));
    return true;
  }, []);

  const pasteTerminalClipboard = useCallback(async () => {
    const instance = terminal.current;
    try {
      if (!navigator.clipboard?.readText) throw new Error("clipboard unavailable");
      const text = await navigator.clipboard.readText();
      sendTerminalText(text);
    } catch {
      setManualPasteText("");
      setManualPasteOpen(true);
    } finally {
      instance?.focus();
    }
  }, [sendTerminalText]);

  const sendTerminalTab = useCallback(() => {
    if (mobileComposing.current) return;
    const pending = mobileCommand;
    if (!sendTerminalText(pending ? `${pending}\t` : "\t")) return;
    if (pending) setMobileCommand("");
  }, [mobileCommand, sendTerminalText]);

  const sendTerminalInterrupt = useCallback(() => {
    if (mobileComposing.current) return;
    sendTerminalText("\u0003");
  }, [sendTerminalText]);

  const submitMobileCommand = useCallback(() => {
    if (mobileComposing.current) return;
    if (!sendTerminalText(`${mobileCommand}\r`)) return;
    if (mobileCommand) setMobileCommand("");
    const dismissKeyboard = () => {
      mobileCommandInput.current?.blur();
      terminalHost.current?.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea")?.blur();
    };
    dismissKeyboard();
    window.requestAnimationFrame(dismissKeyboard);
    window.setTimeout(() => {
      dismissKeyboard();
      window.scrollTo(0, 0);
    }, 80);
  }, [mobileCommand, sendTerminalText]);

  useEffect(() => {
    if (settingsLoading || !terminalHost.current || terminal.current) return;
    const resolved = settingsError ? defaultXtermjsSettings : settings;
    const compactLayout = window.matchMedia(compactTerminalQuery);
    const configuredFontSize = resolved.terminalOptions.fontSize ?? compactTerminalFontSize;
    const configuredPadding = resolved.terminalPadding;
    const terminalFontSize = () => compactLayout.matches
      ? Math.min(configuredFontSize, compactTerminalFontSize)
      : configuredFontSize;
    const terminalPadding = () => compactLayout.matches
      ? Math.min(configuredPadding, compactTerminalPadding)
      : configuredPadding;
    const options: Partial<ITerminalOptions> = {
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: resolved.terminalOptions.cursorBlink,
      convertEol: resolved.terminalOptions.convertEol,
      fontFamily: resolved.terminalOptions.fontFamily,
      fontSize: terminalFontSize(),
      macOptionIsMeta: resolved.terminalOptions.macOptionIsMeta,
      scrollback: resolved.terminalOptions.scrollback,
      theme: resolved.terminalOptions.theme,
    };
    if (resolved.transparentBackground || isTransparentBackground(resolved.terminalOptions.theme?.background)) {
      options.allowTransparency = true;
    }
    const instance = new Terminal(options);
    const fit = new FitAddon();
    instance.loadAddon(fit);
    instance.loadAddon(new WebLinksAddon());
    instance.open(terminalHost.current);
    terminal.current = instance;
    const detachHighlight = attachRemoteTerminalHighlight(instance);
    fitAddon.current = fit;
    terminalHost.current.style.setProperty("--xterm-padding", `${terminalPadding()}px`);
    const helper = terminalHost.current.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
    if (helper) {
      helper.tabIndex = -1;
      helper.setAttribute("aria-hidden", "true");
    }

    const updateTerminalDensity = () => {
      instance.options.fontSize = terminalFontSize();
      terminalHost.current?.style.setProperty("--xterm-padding", `${terminalPadding()}px`);
      resizeTerminal();
    };
    compactLayout.addEventListener("change", updateTerminalDensity);

    const style = document.createElement("style");
    style.dataset.remoteTerminal = node.uuid;
    style.textContent = resolved.customCss;
    document.head.appendChild(style);

    const inputDisposable = instance.onData((data) => {
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new TextEncoder().encode(data));
      }
    });
    let lastControl = -1;
    let lastControlAt = 0;
    const sendControlByte = (byte: number) => {
      const now = performance.now();
      if (lastControl === byte && now - lastControlAt < 50) return;
      lastControl = byte;
      lastControlAt = now;
      const ws = socket.current;
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(new Uint8Array([byte]));
      }
    };
    const swallowBrowserCut = (event: Event) => {
      if (event instanceof InputEvent && event.inputType === "insertText") {
        const leaked = lastControl >= 1 && lastControl <= 26
          ? String.fromCharCode(lastControl + 96)
          : "";
        const data = (event.data || "").toLowerCase();
        if (data.length === 1 && data === leaked && performance.now() - lastControlAt < 50) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      const inputType = event instanceof InputEvent ? event.inputType : "deleteByCut";
      const control = terminalCutControlByte(inputType);
      if (control === null) return;
      event.preventDefault();
      event.stopPropagation();
      sendControlByte(control);
    };
    instance.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" && event.type !== "keypress") return true;
      const decision = terminalKeyAction(event, instance.hasSelection());
      if (decision.action === "copy") {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "keydown") void copyTerminalSelection();
        return false;
      }
      if (decision.action === "paste") {
        // Let the browser emit a ClipboardEvent. Its clipboardData works on
        // HTTP deployments where navigator.clipboard.readText is unavailable.
        return false;
      }
      if (decision.action === "send") {
        event.stopPropagation();
        // Ctrl+C with no terminal selection still goes to the PTY, but the
        // keydown default is left in place so the browser can copy.
        if (!(decision.keepBrowserCopy && event.type === "keydown")) {
          event.preventDefault();
        }
        sendControlByte(decision.byte);
        return false;
      }
      if (event.type === "keypress" && event.key.length === 1 && lastControl >= 1 && lastControl <= 26) {
        const leaked = String.fromCharCode(lastControl + 96);
        if (event.key.toLowerCase() === leaked && performance.now() - lastControlAt < 50) {
          event.preventDefault();
          event.stopPropagation();
          return false;
        }
      }
      return true;
    });
    const resizeObserver = new ResizeObserver(() => resizeTerminal());
    resizeObserver.observe(terminalHost.current);
    const host = terminalHost.current;
    host.addEventListener("beforeinput", swallowBrowserCut, true);
    host.addEventListener("cut", swallowBrowserCut, true);
    const paste = (event: ClipboardEvent) => {
      const text = event.clipboardData?.getData("text/plain") || "";
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      sendTerminalText(text);
    };
    const contextMenu = (event: MouseEvent) => {
      event.preventDefault();
      setContextMenu({
        x: Math.min(event.clientX, window.innerWidth - 176),
        y: Math.min(event.clientY, window.innerHeight - 132),
      });
    };
    const touchStart = (event: TouchEvent) => {
      if (!window.matchMedia(compactTerminalQuery).matches || event.touches.length !== 1) {
        terminalTouch.current = null;
        return;
      }
      const touch = event.touches[0];
      terminalTouch.current = {
        identifier: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        lastY: touch.clientY,
        scrollRemainder: 0,
        moved: false,
      };
    };
    const touchMove = (event: TouchEvent) => {
      const state = terminalTouch.current;
      if (!state || !window.matchMedia(compactTerminalQuery).matches) return;
      const touch = Array.from(event.touches).find((item) => item.identifier === state.identifier);
      if (!touch) return;

      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      if (!state.moved && Math.hypot(touch.clientX - state.startX, touch.clientY - state.startY) < 8) return;
      state.moved = true;

      const screen = host.querySelector<HTMLElement>(".xterm-screen");
      const lineHeight = screen
        ? screen.getBoundingClientRect().height / Math.max(instance.rows, 1)
        : compactTerminalFontSize * 1.2;
      state.scrollRemainder += (state.lastY - touch.clientY) / Math.max(lineHeight, 1);
      state.lastY = touch.clientY;

      const lines = state.scrollRemainder > 0
        ? Math.floor(state.scrollRemainder)
        : Math.ceil(state.scrollRemainder);
      if (lines !== 0) {
        instance.scrollLines(lines);
        state.scrollRemainder -= lines;
      }
    };
    const touchEnd = (event: TouchEvent) => {
      const state = terminalTouch.current;
      if (!state || !Array.from(event.changedTouches).some((item) => item.identifier === state.identifier)) return;
      terminalTouch.current = null;
      if (!state.moved) window.requestAnimationFrame(() => mobileCommandInput.current?.focus({ preventScroll: true }));
    };
    const touchCancel = () => {
      terminalTouch.current = null;
    };
    host.addEventListener("paste", paste, true);
    host.addEventListener("contextmenu", contextMenu);
    host.addEventListener("touchstart", touchStart, { capture: true, passive: true });
    host.addEventListener("touchmove", touchMove, { capture: true, passive: false });
    host.addEventListener("touchend", touchEnd, { capture: true, passive: true });
    host.addEventListener("touchcancel", touchCancel, { capture: true, passive: true });
    setTerminalReady(true);
    return () => {
      compactLayout.removeEventListener("change", updateTerminalDensity);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      host.removeEventListener("paste", paste, true);
      host.removeEventListener("beforeinput", swallowBrowserCut, true);
      host.removeEventListener("cut", swallowBrowserCut, true);
      host.removeEventListener("contextmenu", contextMenu);
      host.removeEventListener("touchstart", touchStart, true);
      host.removeEventListener("touchmove", touchMove, true);
      host.removeEventListener("touchend", touchEnd, true);
      host.removeEventListener("touchcancel", touchCancel, true);
      detachHighlight();
      instance.dispose();
      style.remove();
      terminal.current = null;
      fitAddon.current = null;
    };
  }, [copyTerminalSelection, node.uuid, resizeTerminal, sendTerminalText, settings, settingsError, settingsLoading]);

  useEffect(() => {
    const update = () => resizeTerminal();
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.clearTimeout(fitTimer.current);
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, [resizeTerminal]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", keydown);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!terminalReady) return;
    let disposed = false;
    let heartbeat: number | undefined;
    let agentWaitTimeout: number | undefined;
    let ws: WebSocket | undefined;
    let sessionLease: ReturnType<typeof createRemoteSessionLease> | undefined;
    const abortController = new AbortController();
    const clearHeartbeat = () => {
      if (heartbeat !== undefined) {
        window.clearInterval(heartbeat);
        heartbeat = undefined;
      }
    };
    const clearAgentWaitTimeout = () => {
      if (agentWaitTimeout !== undefined) {
        window.clearTimeout(agentWaitTimeout);
        agentWaitTimeout = undefined;
      }
    };

    const connect = async () => {
      setConnectionState("connecting");
      setConnectionError("");
      remoteReadyRef.current = false;
      setRemoteReady(false);
      try {
        if (node.remote_protocol !== 2) {
          throw new Error(t("terminal.session.errors.agent_too_old"));
        }
        if (node.remote_control_enabled === false) {
          throw new Error(t("terminal.session.errors.agent_disabled"));
        }
        const payload = await createSession(node.uuid, abortController.signal);
        sessionLease = createRemoteSessionLease(payload.session_id);
        if (disposed) {
          sessionLease.release();
          return;
        }
        const sessionID = sessionLease.sessionID;
        const browserTicket = payload.browser_ticket;
        const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(`${protocol}//${window.location.host}/api/admin/client/remote`);
        ws.binaryType = "arraybuffer";
        socket.current = ws;
        ws.onopen = () => {
          if (disposed) {
            ws?.close();
            return;
          }
          ws?.send(JSON.stringify({ type: "auth", session_id: sessionID, ticket: browserTicket }));
          setConnectionState("waiting");
          agentWaitTimeout = window.setTimeout(() => {
            if (disposed || remoteReadyRef.current) return;
            const message = t("terminal.session.agent_timeout");
            setConnectionState("error");
            setConnectionError(message);
            terminal.current?.writeln(`\r\n${message}`);
            sessionLease?.release();
            ws?.close();
          }, remoteAgentWaitTimeoutMs);
          heartbeat = window.setInterval(() => {
            if (ws?.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: "heartbeat", timestamp: Date.now() }));
            }
          }, 10_000);
        };
        ws.onmessage = (event) => {
          if (disposed) return;
          if (event.data instanceof ArrayBuffer) {
            if (fileManager.current?.handleBinary(event.data)) return;
            terminal.current?.write(new Uint8Array(event.data));
            return;
          }
          try {
            const message = JSON.parse(event.data);
            if (message.type === "remote.ready") {
              clearAgentWaitTimeout();
              setConnectionState("connected");
              remoteReadyRef.current = true;
              setRemoteReady(true);
              setRemoteTerminalInputEnabled(terminal.current, true);
              fileManager.current?.initialize(message.roots || [], message.home || message.roots?.[0], message.separator || "/", message.file_transfer || 1);
              resizeTerminal();
              if (activeRef.current && !isEditableElement(document.activeElement)) {
                window.requestAnimationFrame(() => terminal.current?.focus());
              }
            } else if (message.type === "remote.status") {
              setConnectionState(message.status === "waiting" ? "waiting" : "connecting");
            } else if (message.type === "remote.error") {
              clearAgentWaitTimeout();
              remoteReadyRef.current = false;
              setRemoteReady(false);
              setRemoteTerminalInputEnabled(terminal.current, false);
              setConnectionState("error");
              const localizedMessage = localizeRemoteError(message.message, t);
              setConnectionError(localizedMessage);
              terminal.current?.writeln(`\r\n${localizedMessage}`);
              sessionLease?.release();
            } else if (message.type?.startsWith("file.")) {
              fileManager.current?.handleMessage(message);
            }
          } catch {
            terminal.current?.write(event.data);
          }
        };
        ws.onerror = () => {
          if (disposed) return;
          clearAgentWaitTimeout();
          sessionLease?.release();
          setRemoteTerminalInputEnabled(terminal.current, false);
          setConnectionState("error");
          setConnectionError(t("terminal.session.connection_error"));
        };
        ws.onclose = () => {
          clearHeartbeat();
          clearAgentWaitTimeout();
          sessionLease?.release();
          setRemoteTerminalInputEnabled(terminal.current, false);
          if (!disposed) {
            remoteReadyRef.current = false;
            setRemoteReady(false);
            setConnectionState((current) => current === "error" ? current : "disconnected");
            terminal.current?.writeln(`\r\n${t("terminal.session.disconnected_notice")}`);
          }
        };
      } catch (error) {
        sessionLease?.release();
        if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) {
          setConnectionState("error");
          setConnectionError(error instanceof Error ? error.message : t("terminal.session.connection_failed"));
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      abortController.abort();
      remoteReadyRef.current = false;
      clearHeartbeat();
      clearAgentWaitTimeout();
      if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) ws.close();
      sessionLease?.release();
      if (socket.current === ws) socket.current = null;
    };
  }, [createSession, node.remote_control_enabled, node.remote_protocol, node.uuid, reconnectKey, resizeTerminal, t, terminalReady]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => {
      resizeTerminal();
      if (!isEditableElement(document.activeElement)) terminal.current?.focus();
    }, 50);
    return () => window.clearTimeout(timer);
  }, [active, sidePanel, sideWidth, resizeTerminal]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current) return;
      setSideWidth(Math.min(620, Math.max(320, window.innerWidth - event.clientX)));
    };
    const stop = () => { dragging.current = false; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
  }, []);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN || !remoteReadyRef.current) return false;
    ws.send(JSON.stringify(message));
    return true;
  }, []);

  const sendBinary = useCallback((payload: Uint8Array) => {
    const ws = socket.current;
    if (ws?.readyState !== WebSocket.OPEN || !remoteReadyRef.current) return false;
    ws.send(payload);
    return true;
  }, []);

  const sendCommand = useCallback((command: string) => {
    const ws = socket.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(new TextEncoder().encode(`${command}\r`));
    }
  }, []);

  const contextValue = useMemo(
    () => ({ terminal: terminalReady ? terminal.current : null, sendCommand }),
    [sendCommand, terminalReady],
  );
  const reconnect = () => {
    terminal.current?.reset();
    setRemoteTerminalInputEnabled(terminal.current, false);
    setReconnectKey((value) => value + 1);
  };
  const flag = node.region_override?.trim() || node.region?.trim() || "UN";
  const address = displayRemoteAddress(node.ipv4) || displayRemoteAddress(node.ipv6) || UNREPORTED_ADDRESS;
  const cpuUsed = live?.cpu.usage || 0;
  const ramUsed = usagePercent(live?.ram.used, node.mem_total);
  const diskUsed = usagePercent(live?.disk.used, node.disk_total);
  const cores = cpuCoreCount(node.cpu_cores);
  const metrics = [
    {
      key: "cpu",
      label: "CPU",
      icon: <Cpu size={14} />,
      value: `${cpuUsed.toFixed(1)}%`,
      detail: cores ? t("terminal.session.cpu_cores", { count: cores }) : "",
      percent: cpuUsed,
    },
    {
      key: "ram",
      label: t("nodeCard.ram"),
      icon: <MemoryStick size={14} />,
      value: percentage(live?.ram.used, node.mem_total),
      detail: volumeDetail(live?.ram.used, node.mem_total),
      percent: ramUsed,
    },
    {
      key: "disk",
      label: t("nodeCard.disk"),
      icon: <HardDrive size={14} />,
      value: percentage(live?.disk.used, node.disk_total),
      detail: volumeDetail(live?.disk.used, node.disk_total),
      percent: diskUsed,
    },
    { key: "up", label: t("terminal.session.net_up"), icon: <ArrowUp size={14} />, value: `${formatBytes(live?.network.up || 0)}/s`, tone: "is-up" },
    { key: "down", label: t("terminal.session.net_down"), icon: <ArrowDown size={14} />, value: `${formatBytes(live?.network.down || 0)}/s`, tone: "is-down" },
  ];
  const visibleMetrics = compact ? metrics.slice(0, 3) : metrics;
  const mobilePanel = compact && Boolean(sidePanel);

  return (
    <TerminalContext.Provider value={contextValue}>
      <div className={`remote-session${mobilePanel ? " has-mobile-panel" : ""}`} style={{ display: active ? "flex" : "none" }}>
        {!mobilePanel ? (
        <>
        <Box className="remote-identity">
          <Box className="remote-identity-flag">
            <Flag flag={flag} width={40} height={30} />
          </Box>
          <Box className="remote-identity-copy">
            <Typography component="h1" variant="h5" noWrap title={node.name} sx={{ m: 0, fontSize: "inherit", fontWeight: 700, lineHeight: 1.25 }}>
              {node.name}
            </Typography>
            <Box className="remote-identity-meta">
              <span className={`remote-identity-address${address === UNREPORTED_ADDRESS ? "" : " is-ip"}`}>{address}</span>
              <span className={`remote-status is-${connectionState}`}><i />{stateLabel(connectionState, t)}</span>
            </Box>
          </Box>
          <Box className="remote-session-actions">
            {compact ? (
              <>
                <IconButton
                  aria-label={t("terminal.session.more")}
                  onClick={(event) => setMoreAnchor(event.currentTarget)}
                >
                  <MoreHorizontal size={18} />
                </IconButton>
                <Menu
                  anchorEl={moreAnchor}
                  open={Boolean(moreAnchor)}
                  onClose={() => setMoreAnchor(null)}
                  {...getAdminMenuProps()}
                >
                  <MenuItem onClick={() => { setMoreAnchor(null); void copyTerminalSelection(); }}>{t("terminal.session.copy_selection")}</MenuItem>
                  <MenuItem disabled={!remoteReady} onClick={() => { setMoreAnchor(null); void pasteTerminalClipboard(); }}>{t("terminal.session.paste")}</MenuItem>
                  <MenuItem onClick={() => { setMoreAnchor(null); onDuplicate(); }}>{t("terminal.session.duplicate_session")}</MenuItem>
                  <MenuItem onClick={() => { setMoreAnchor(null); reconnect(); }}>{t("terminal.session.reconnect")}</MenuItem>
                </Menu>
              </>
            ) : (
              <>
                <Button size="small" onClick={onDuplicate} sx={{ gap: 0.75 }}>
                  <Copy size={15} />
                  {t("terminal.session.duplicate_session")}
                </Button>
                <Button size="small" variant="outlined" onClick={reconnect} sx={{ gap: 0.75 }}>
                  <RotateCw size={15} />
                  {t("terminal.session.reconnect")}
                </Button>
                {!sidePanel ? (
                  <Button
                    size="small"
                    variant="outlined"
                    onClick={() => setSidePanel("files")}
                    sx={{ gap: 0.75 }}
                  >
                    <PanelRightClose size={15} />
                    {t("terminal.session.open_sidebar")}
                  </Button>
                ) : null}
              </>
            )}
          </Box>
        </Box>

        <Box className="remote-metrics">
          {visibleMetrics.map((metric) => (
            <Paper key={metric.key} className={`remote-metric ${metric.tone || ""}${metric.percent != null ? " has-usage" : ""}`} variant="outlined" sx={usageMetricCardSx}>
              <small>{metric.icon}{metric.label}</small>
              <div className="remote-metric-row">
                <strong>{metric.value}</strong>
                {metric.detail ? <span className="remote-metric-detail">{metric.detail}</span> : null}
              </div>
              {metric.percent != null ? (
                <div className={`remote-metric-bar is-${usageTone(metric.percent)}`}>
                  <i style={{ width: `${Math.min(100, Math.max(0, metric.percent))}%` }} />
                </div>
              ) : null}
            </Paper>
          ))}
        </Box>
        {compact ? (
          <div className="remote-network">
            <span className="is-up"><ArrowUp size={12} />{t("terminal.session.net_up_short")} <strong>{formatBytes(live?.network.up || 0)}/s</strong></span>
            <span className="remote-network-rule" />
            <span className="is-down"><ArrowDown size={12} />{t("terminal.session.net_down_short")} <strong>{formatBytes(live?.network.down || 0)}/s</strong></span>
          </div>
        ) : null}
        </>
        ) : null}

        <main className="remote-session-body">
          <div className="remote-terminal-pane">
            <div className="remote-terminal-head">
              <span className="remote-terminal-head-title">
                <TerminalIcon size={16} />
                {t("terminal.session.terminal")}
              </span>
              <span className="remote-terminal-head-actions">
                <IconButton size="small" aria-label={t("terminal.session.copy_selection")} onClick={() => void copyTerminalSelection()}>
                  <ClipboardCopy size={15} />
                </IconButton>
                <IconButton size="small" aria-label={t("terminal.session.paste")} disabled={!remoteReady} onClick={() => void pasteTerminalClipboard()}>
                  <ClipboardPaste size={15} />
                </IconButton>
                {!sidePanel ? (
                  <IconButton size="small" aria-label={t("terminal.session.open_sidebar")} title={t("terminal.session.open_sidebar")} onClick={() => setSidePanel("files")}>
                    <PanelRightClose size={15} />
                  </IconButton>
                ) : null}
              </span>
            </div>
            <div
              ref={terminalHost}
              className="terminal-page terminal-xterm-host"
              style={{ flex: 1, minHeight: 0 }}
            />
            {compact ? (
              <div className="remote-terminal-tools">
                <button type="button" onClick={() => void copyTerminalSelection()}>
                  <ClipboardCopy size={13} />
                  {t("common.copy")}
                </button>
                <button type="button" disabled={!remoteReady} onClick={() => void pasteTerminalClipboard()}>
                  <ClipboardPaste size={13} />
                  {t("terminal.session.paste")}
                </button>
                <button
                  type="button"
                  disabled={!remoteReady}
                  aria-label={t("terminal.session.tab_complete")}
                  onClick={sendTerminalTab}
                >
                  <KeyboardTab size={13} />
                  Tab
                </button>
                <button
                  type="button"
                  disabled={!remoteReady}
                  aria-label={t("terminal.session.send_ctrl_c")}
                  onClick={sendTerminalInterrupt}
                >
                  Ctrl+C
                </button>
              </div>
            ) : null}
            <form
              className="remote-mobile-command"
              style={compact && sidePanel ? { display: "none" } : undefined}
              onSubmit={(event) => {
                event.preventDefault();
                event.stopPropagation();
                submitMobileCommand();
              }}
            >
              <label className="remote-mobile-input">
                <span aria-hidden="true">›</span>
                <input
                  ref={mobileCommandInput}
                  type="text"
                  value={mobileCommand}
                  placeholder={t("terminal.session.input_command")}
                  aria-label={t("terminal.session.input_command_aria")}
                  inputMode="text"
                  enterKeyHint="send"
                  autoCapitalize="none"
                  autoCorrect="off"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!remoteReady}
                  onChange={(event) => setMobileCommand(event.target.value)}
                  onCompositionStart={() => { mobileComposing.current = true; }}
                  onCompositionEnd={() => { mobileComposing.current = false; }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && (event.nativeEvent.isComposing || mobileComposing.current || event.keyCode === 229)) {
                      event.stopPropagation();
                    }
                  }}
                />
              </label>
              <button
                type="submit"
                className="remote-mobile-send"
                aria-label={mobileCommand ? t("terminal.session.send_command") : t("terminal.session.send_enter")}
                disabled={!remoteReady}
              >
                <CornerDownLeft size={18} />
              </button>
            </form>
            {(connectionState === "error" || connectionState === "disconnected") && (
              <div className="remote-reconnect">
                <span>{connectionError || t("terminal.disconnect")}</span>
                {!isPermanentRemoteError(connectionError, t) && (
                  <Button size="small" variant="contained" onClick={reconnect} sx={{ gap: 0.75 }}>
                    <RotateCw size={14} />
                    {t("terminal.session.reconnect")}
                  </Button>
                )}
              </div>
            )}
          </div>
          {sidePanel && !compact ? <div className="remote-divider" onPointerDown={() => { dragging.current = true; }} /> : null}
          <aside className="remote-side-panel" style={{ width: sidePanel ? (compact ? undefined : sideWidth) : 0, display: sidePanel ? "flex" : "none", flexDirection: "column" }}>
            <Box className="remote-side-tabs">
              <Tabs
                value={sidePanel || "files"}
                onChange={(_event, value) => setSidePanel(value)}
                variant="standard"
                sx={{ minHeight: 43, minWidth: 0, "& .MuiTab-root": { minHeight: 43, minWidth: 0, px: 1.5, textTransform: "none", fontSize: 12, gap: "7px" } }}
              >
                <Tab value="files" icon={<Files size={16} />} iconPosition="start" label={t("terminal.session.files")} />
                <Tab value="commands" icon={<ClipboardList size={16} />} iconPosition="start" label={t("terminal.session.commands")} />
              </Tabs>
              {!compact ? (
                <IconButton size="small" aria-label={t("terminal.session.close_sidebar")} onClick={() => setSidePanel(null)}>
                  <PanelRightClose size={16} />
                </IconButton>
              ) : null}
            </Box>
            <Box sx={{ display: sidePanel === "files" ? "block" : "none", minHeight: 0, flex: 1, height: "100%" }}>
              <FileManager ref={fileManager} send={send} sendBinary={sendBinary} connected={remoteReady} />
            </Box>
            <Box sx={{ display: sidePanel === "commands" ? "block" : "none", minHeight: 0, flex: 1, height: "100%" }}>
              <div className="remote-command-panel"><CommandClipboardPanel className="h-full w-full" /></div>
            </Box>
          </aside>
        </main>

        {compact ? (
          <BottomNavigation
            className="remote-bottom-nav"
            showLabels
            value={sidePanel || "terminal"}
            onChange={(_event, value) => {
              setSidePanel(value === "terminal" ? null : value);
            }}
          >
            <BottomNavigationAction value="terminal" label={t("terminal.session.terminal")} icon={<TerminalIcon size={18} />} />
            <BottomNavigationAction value="files" label={t("terminal.session.files")} icon={<Files size={18} />} />
            <BottomNavigationAction value="commands" label={t("terminal.session.commands")} icon={<ClipboardList size={18} />} />
          </BottomNavigation>
        ) : null}

        <Dialog {...remoteConfirmDialogProps} open={manualPasteOpen} onClose={() => setManualPasteOpen(false)} maxWidth="sm">
          <DialogTitle>{t("terminal.session.paste_to_terminal")}</DialogTitle>
          <DialogContent>
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={7}
              value={manualPasteText}
              onChange={(event) => setManualPasteText(event.target.value)}
            />
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setManualPasteOpen(false)}>{t("common.cancel")}</Button>
            <Button
              variant="contained"
              disabled={!manualPasteText}
              onClick={() => {
                if (sendTerminalText(manualPasteText)) {
                  setManualPasteOpen(false);
                  setManualPasteText("");
                  terminal.current?.focus();
                }
              }}
            >
              {t("terminal.session.insert")}
            </Button>
          </DialogActions>
        </Dialog>

        {contextMenu && (
          <div
            className="remote-terminal-context-menu"
            role="menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" disabled={!terminal.current?.hasSelection()} onClick={() => {
              setContextMenu(null);
              void copyTerminalSelection();
            }}><ClipboardCopy size={15} />{t("common.copy")}</button>
            <button type="button" role="menuitem" disabled={!remoteReady} onClick={() => {
              setContextMenu(null);
              void pasteTerminalClipboard();
            }}><ClipboardPaste size={15} />{t("terminal.session.paste")}</button>
            <button type="button" role="menuitem" onClick={() => {
              terminal.current?.selectAll();
              setContextMenu(null);
            }}><TextSelect size={15} />{t("common.select_all")}</button>
          </div>
        )}

        {!online && connectionState !== "connected" && <span className="sr-only">{t("terminal.session.node_offline")}</span>}
      </div>
    </TerminalContext.Provider>
  );
}
