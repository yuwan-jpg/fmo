import assert from "node:assert/strict";

import {
  buildAuthUrl,
  buildBasicAuthHeader,
  buildWebSocketUrl,
  formatAddressForDisplay,
  getEffectiveWebSocketProtocol,
  getLocalMdnsTroubleshootingMessage,
  getProtocolFromAddress,
  isLocalMdnsHost,
  isValidHostAddress,
  normalizeHost,
  parseAddressWithAuth,
  parseAuthInfo,
} from "../src/utils/urlUtils.js";

const normalizeCases = [
  ["192.168.1.100", "192.168.1.100"],
  ["ws://192.168.1.100/ws", "192.168.1.100"],
  ["http://fmo.example.net:40088/ws", "fmo.example.net:40088"],
  ["wss://fmo.example.net/events", "fmo.example.net"],
  ["https://fmo.example.net:443/events?token=abc", "fmo.example.net:443"],
  ["fmo.example.net：40088", "fmo.example.net:40088"],
  ["my_fmo_gateway.local", "my_fmo_gateway.local"],
  // 带 userinfo 的地址，normalize 后剥离凭据
  ["hamuser:secret@203.0.113.10:3800", "203.0.113.10:3800"],
  ["http://hamuser:secret@203.0.113.10:3800/ws", "203.0.113.10:3800"],
  ["ws://user:p%40ss@fmo.example.net:40088/ws", "fmo.example.net:40088"],
];

for (const [input, expected] of normalizeCases) {
  assert.equal(normalizeHost(input), expected, `normalizeHost(${input})`);
}

const validHosts = [
  "fmo.local",
  "192.168.1.100",
  "fmo.example.net",
  "fmo.example.net:40088",
  "http://fmo.example.net:40088/ws",
  "ws://fmo.example.net:40088/events",
  "fmo-gateway_1.local",
  // 带 Basic Auth 的 user:pass@host 形式
  "hamuser:secret@192.168.1.100",
  "hamuser:secret@203.0.113.10:3800",
  "hamuser:secret@fmo.example.net:40088",
  "ws://hamuser:secret@fmo.example.net:40088/ws",
];

for (const input of validHosts) {
  assert.equal(
    isValidHostAddress(input),
    true,
    `expected valid host: ${input}`,
  );
}

const invalidHosts = [
  "",
  "fmo host.local",
  "fmo@example.net",
  "fmo.example.net:70000",
];

for (const input of invalidHosts) {
  assert.equal(
    isValidHostAddress(input),
    false,
    `expected invalid host: ${input}`,
  );
}

const protocolCases = [
  ["http://fmo.example.net/ws", "wss", "ws"],
  ["ws://fmo.example.net/ws", "wss", "ws"],
  ["https://fmo.example.net/ws", "ws", "wss"],
  ["wss://fmo.example.net/ws", "ws", "wss"],
  ["fmo.example.net", "wss", "wss"],
  ["fmo.example.net", "ws", "ws"],
];

for (const [input, fallback, expected] of protocolCases) {
  assert.equal(
    getProtocolFromAddress(input, fallback),
    expected,
    `getProtocolFromAddress(${input})`,
  );
}

assert.equal(getEffectiveWebSocketProtocol("fmo.example.net", "https"), "wss");
assert.equal(getEffectiveWebSocketProtocol("fmo.example.net", "http"), "ws");
assert.equal(
  buildWebSocketUrl("http://fmo.example.net:40088/ws", "ws"),
  "ws://fmo.example.net:40088/ws",
);
assert.equal(
  buildWebSocketUrl("https://fmo.example.net/events", "wss", "/events"),
  "wss://fmo.example.net/events",
);

assert.equal(isLocalMdnsHost("fmo.local"), true);
assert.equal(isLocalMdnsHost("my_fmo_gateway.local:40088"), true);
assert.equal(isLocalMdnsHost("fmo.example.net"), false);
assert.match(
  getLocalMdnsTroubleshootingMessage("ws://fmo.local/ws"),
  /局域网 IP/,
);

// ========== Basic Auth 支持 ==========

// parseAuthInfo
assert.deepEqual(parseAuthInfo("192.168.1.100"), {
  host: "192.168.1.100",
  username: "",
  password: "",
});
assert.deepEqual(parseAuthInfo("hamuser:secret@203.0.113.10:3800"), {
  host: "203.0.113.10:3800",
  username: "hamuser",
  password: "secret",
});
assert.deepEqual(parseAuthInfo("ws://hamuser:secret@203.0.113.10:3800/ws"), {
  host: "203.0.113.10:3800",
  username: "hamuser",
  password: "secret",
});
assert.deepEqual(
  parseAuthInfo("http://hamuser:p%40ss%3Aword@fmo.example.net:40088/ws"),
  {
    host: "fmo.example.net:40088",
    username: "hamuser",
    password: "p@ss:word",
  },
);

// parseAddressWithAuth
assert.deepEqual(
  parseAddressWithAuth("http://hamuser:secret@203.0.113.10:3800"),
  {
    host: "203.0.113.10:3800",
    username: "hamuser",
    password: "secret",
    protocol: "ws",
    httpProtocol: "http",
  },
);
assert.deepEqual(
  parseAddressWithAuth("wss://user:pass@fmo.example.net:443/ws"),
  {
    host: "fmo.example.net:443",
    username: "user",
    password: "pass",
    protocol: "wss",
    httpProtocol: "https",
  },
);

// buildBasicAuthHeader（UTF-8，支持中文密码）
assert.equal(
  buildBasicAuthHeader("hamuser", "secret"),
  "Basic aGFtdXNlcjpzZWNyZXQ=",
);
assert.equal(
  buildBasicAuthHeader("hamuser", "密碼"),
  "Basic aGFtdXNlcjrlr4bnorw=",
);

// buildAuthUrl
assert.equal(
  buildAuthUrl("203.0.113.10:3800", "hamuser", "secret"),
  "http://hamuser:secret@203.0.113.10:3800",
);
assert.equal(
  buildAuthUrl("203.0.113.10:3800", "hamuser", "p@ss", "https"),
  "https://hamuser:p%40ss@203.0.113.10:3800",
);

// formatAddressForDisplay
assert.equal(
  formatAddressForDisplay("203.0.113.10:3800", "hamuser", "secret"),
  "hamuser:***@203.0.113.10:3800",
);
assert.equal(formatAddressForDisplay("192.168.1.100", "", ""), "192.168.1.100");

console.log("urlUtils tests passed");
