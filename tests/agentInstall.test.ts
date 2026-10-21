import assert from "node:assert/strict";
import test from "node:test";

import {
  LITE_AGENT_DOCKER_IMAGE,
  LITE_AGENT_GITHUB_REPO,
  LITE_AGENT_INSTALL_USER_AGENT,
  defaultInstallGitHubProxy,
  liteAgentInstallScriptUrl,
  liteAgentLinuxInstallCommand,
  liteAgentMacInstallCommand,
  liteAgentWindowsInstallCommand,
  rewriteGitHubURL,
} from "../src/utils/agentInstall.ts";

test("one-click install uses Lite-agent latest, not a pinned release", () => {
  assert.equal(LITE_AGENT_GITHUB_REPO, "nuomiiiii/Lite-agent");
  assert.match(LITE_AGENT_INSTALL_USER_AGENT, /github\.com\/nuomiiiii\/Lite-agent/);
  assert.equal(LITE_AGENT_DOCKER_IMAGE, "ghcr.io/nuomiiiii/lite-agent:latest");
  assert.doesNotMatch(LITE_AGENT_DOCKER_IMAGE, /Lite-agent/);
  assert.match(LITE_AGENT_DOCKER_IMAGE, /:latest$/);
  assert.doesNotMatch(LITE_AGENT_DOCKER_IMAGE, /\d+\.\d+\.\d+\.\d+/);
  assert.equal(
    liteAgentInstallScriptUrl("install.sh"),
    "https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.sh",
  );
  assert.equal(
    liteAgentInstallScriptUrl("install.ps1"),
    "https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.ps1",
  );
  assert.doesNotMatch(liteAgentInstallScriptUrl("install.sh"), /komari-agent/);
  assert.doesNotMatch(liteAgentInstallScriptUrl("install.sh"), /install-version/);
});

test("deploy commands reuse the general GitHub proxy when checked", () => {
  assert.equal(defaultInstallGitHubProxy({ github_proxy: " https://gh-proxy.com/ " }), "https://gh-proxy.com/");
  assert.equal(defaultInstallGitHubProxy({ github_proxy: "" }), "");
  assert.equal(defaultInstallGitHubProxy({}), "");
  assert.equal(defaultInstallGitHubProxy(null), "");
});

test("ghproxy prefixes the Lite-agent script URL with the full https target", () => {
  assert.equal(
    rewriteGitHubURL(
      "https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.sh",
      "https://ghproxy.example/",
    ),
    "https://ghproxy.example/https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.sh",
  );
  assert.equal(
    liteAgentInstallScriptUrl("install.sh", "https://ghproxy.example/"),
    "https://ghproxy.example/https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.sh",
  );
  assert.equal(
    liteAgentInstallScriptUrl("install.sh", "https://ghproxy.example"),
    "https://ghproxy.example/https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.sh",
  );
  assert.doesNotMatch(
    liteAgentInstallScriptUrl("install.sh", "https://ghproxy.example"),
    /ghproxy\.example\/raw\.githubusercontent\.com/,
  );
});

test("install commands send a User-Agent when fetching the script", () => {
  const scriptUrl =
    "https://ghproxy.example/https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.sh";
  const linux = liteAgentLinuxInstallCommand(scriptUrl, ["-e", "https://lite.example"]);
  assert.match(linux, /wget -qO- -U /);
  assert.equal(linux.includes(LITE_AGENT_INSTALL_USER_AGENT), true);
  assert.match(linux, /sudo bash -s --/);

  const mac = liteAgentMacInstallCommand(scriptUrl, ["-e", "https://lite.example"]);
  assert.match(mac, /curl -sL -A /);
  assert.equal(mac.includes(LITE_AGENT_INSTALL_USER_AGENT), true);

  const windows = liteAgentWindowsInstallCommand(
    "https://ghproxy.example/https://raw.githubusercontent.com/nuomiiiii/Lite-agent/main/install.ps1",
    ["-e", "https://lite.example"],
  );
  assert.match(windows, /iwr /);
  assert.match(windows, / -UserAgent /);
  assert.equal(windows.includes(LITE_AGENT_INSTALL_USER_AGENT), true);
  assert.match(windows, /install\.ps1/);
});
