// Offline: the message format.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ccc } from "@ckb-ccc/core";
import { message, parseMessage } from "../src/index.ts";
import { vectors } from "./helpers.ts";

const lock = { codeHash: `0x${"9b".repeat(32)}`, hashType: "type", args: "0x00" } as const;
const chain = "0x10639e0895502b5688a6be8cf69460d76541bfa4821629d86d62ba0aae3f9606";
const input = { domain: "dao.example", account: "user-42", lock, chain, issuedAt: "2026-11-04T18:00:00Z", nonce: "a1b2c3" };

test("message() writes the six lines in order", () => {
  assert.equal(
    message(input),
    [
      "dao.example wants you to prove control of a CKB lock.",
      "Account: user-42",
      `Lock hash: ${ccc.Script.from(lock).hash()}`,
      `Chain: ${chain}`,
      "Issued at: 2026-11-04T18:00:00Z",
      "Nonce: a1b2c3",
    ].join("\n"),
  );
});

test("parseMessage() reads back what message() writes", () => {
  const f = parseMessage(message(input));
  assert.deepEqual(f, { domain: "dao.example", account: "user-42", lockHash: ccc.Script.from(lock).hash(), chain, issuedAt: "2026-11-04T18:00:00Z", nonce: "a1b2c3" });
});

test("every vector's message parses and names the vector's lock", () => {
  for (const v of vectors) assert.equal(parseMessage(v.message).lockHash, ccc.Script.from(v.lock).hash(), v.file);
});

test("malformed messages are refused", () => {
  const good = message(input);
  const bad = [
    good + "\n",
    good.replace("Account: ", "Acount: "),
    good.replace("dao.example", "dao example"),
    good.replace(chain, chain.toUpperCase().replace("0X", "0x")),
    good.replace("2026-11-04T18:00:00Z", "2026-11-04 18:00:00"),
    good.replace("Nonce: a1b2c3", "Nonce: "),
    good.replace("user-42", "user\u000742"),
    good.replace("a1b2c3", "a".repeat(1100)),
  ];
  for (const text of bad) assert.throws(() => parseMessage(text), Error, JSON.stringify(text.slice(-40)));
  assert.throws(() => message({ ...input, account: "two\nlines" }));
});

test("account: printable ASCII only, no space at either end", () => {
  const at = (account: string) => () => message({ ...input, account });
  const cp = (n: number) => String.fromCodePoint(n);
  // Line separator, right-to-left override, a C1 control, a non-ASCII letter, edge spaces, too long.
  for (const bad of [`a${cp(0x2028)}b`, `a${cp(0x202e)}b`, `a${cp(0x85)}b`, `caf${cp(0xe9)}`, " a", "a ", "", "x".repeat(257)]) {
    assert.throws(at(bad), /bad account/, JSON.stringify(bad));
    assert.throws(() => parseMessage(message(input).replace("Account: user-42", `Account: ${bad}`)), Error, JSON.stringify(bad));
  }
  for (const good of ["a", "user 42", "~!@#$%^&*()_+{}|:<>?", "x".repeat(256)]) assert.equal(parseMessage(message({ ...input, account: good })).account, good);
});
