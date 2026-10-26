import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../src/pages/admin/nodemgt/index.tsx", import.meta.url), "utf8");

const coreDefaults = source.slice(source.indexOf("function defaultCore("), source.indexOf("function displayCore("));
const protocolHandlers = [...source.matchAll(/value=\{sheet\.form\.protocol\}\s+onChange=\{\(value\) => \{([\s\S]*?)\n\s+\}\}/g)];
assert.equal(protocolHandlers.length, 2);

for (const [index, handler] of protocolHandlers.entries()) {
  test(`${index === 0 ? "inbound" : "outbound"} protocol changes keep compatible cores and replace unsupported ones`, () => {
    const script = stripTypeScriptTypes(`${source.match(/^const CORES = .*$/m)![0]}\n${coreDefaults}\n${handler[1]}`);
    for (const [protocol, core, expected] of [
      ["vless", "sing-box", "sing-box"],
      ["vmess", "sing-box", "sing-box"],
      ["trojan", "sing-box", "sing-box"],
      ["vless", "xray", "xray"],
      ["anytls", "xray", "sing-box"],
      ["hysteria2", "xray", "sing-box"],
      ["tuic", "xray", "sing-box"],
    ]) {
      let patch: Record<string, string> = {};
      runInNewContext(script, {
        value: protocol,
        sheet: { form: { core } },
        setForm: (value: Record<string, string>) => { patch = value; },
        defaultInboundFlow: () => "",
        securitiesFor: () => ["none", "tls", "reality"],
      });
      assert.equal(patch.protocol, protocol);
      assert.equal(patch.core, expected, `${core} -> ${protocol}`);
    }
  });
}

test("existing inbound keeps empty flow instead of filling vision", () => {
  assert.match(source, /flow: str\(row\?\.flow, existing \? "" : defaultInboundFlow\(protocol, transport, security, core\)\)/);
});

test("tls inbound defaults to empty flow, reality still defaults to vision", () => {
  assert.match(source, /return security === "reality" \? "xtls-rprx-vision" : ""/);
  assert.match(
    source,
    /flow: defaultInboundFlow\(sheet\.form\.protocol, value === "reality" \? "tcp" : sheet\.form\.transport, value, sheet\.form\.core\)/,
  );
});

test("sing-box inbounds cannot use vision flow", () => {
  assert.match(source, /if \(core === "sing-box"\) return false;/);
});

test("choosing reality fills a short id instead of leaving the field blank", () => {
  assert.match(source, /value === "reality" \? sheet\.form\.reality_short_id \|\| randomRealityShortID\(\) : ""/);
});

test("new outbound copies uuid from the inbound's granted user", () => {
  assert.match(source, /const uuid = uuidForInbound\(inbound, users\) \|\| sheet\?\.form\.uuid \|\| ""/);
});

test("new user save uses upsert secret instead of a second credential issue", () => {
  assert.match(source, /const secret = str\(saved\?\.secret\)/);
  assert.doesNotMatch(source, /admin:nodemgt\.credential\.issue/);
});

test("save and delete patch the list before reload so a fetch failure cannot hide the change", () => {
  assert.match(source, /patchNodemgtSnapshot/);
  assert.match(source, /userViewFromUpsert/);
  assert.match(source, /loadAfterChange/);
  assert.match(source, /reload:\s*true/);
  assert.match(source, /DELETE_LIST_KEY/);
  assert.match(source, /commitRows\(key/);
});

test("delete toasts as soon as the row is gone instead of waiting for the full reload", () => {
  assert.match(
    source,
    /const removeRow = async \(method: string, id: string\) => \{[\s\S]*?toast\.success\(t\("nodemgt.saved"\)\);[\s\S]*?void load\(\{ force: true, reload: true \}\)/,
  );
});
