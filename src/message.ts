import { ccc } from "@ckb-ccc/core";

/** The six fields of a proof message, in order. */
export interface MessageFields {
  /** Host of the platform asking for the proof, e.g. "dao.example". */
  domain: string;
  /** The platform account the lock is being linked to. */
  account: string;
  /** Script hash of the lock being proven. */
  lockHash: ccc.Hex;
  /** Genesis block hash of the chain the lock lives on. */
  chain: ccc.Hex;
  /** RFC 3339 UTC time the platform issued the request, e.g. "2026-11-04T18:00:00Z". */
  issuedAt: string;
  /** Single use value chosen by the platform. */
  nonce: string;
}

export interface MessageInput {
  domain: string;
  account: string;
  lock: ccc.ScriptLike;
  chain: ccc.HexLike;
  issuedAt: string | Date;
  nonce: string;
}

export const MAX_MESSAGE_BYTES = 1024;

const HEADER = " wants you to prove control of a CKB lock.";
const DOMAIN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::[0-9]{1,5})?$/;
/**
 * Printable ASCII, 1 to 256 characters, no space at either end. Anything wider lets an account
 * name hide or reorder text where a wallet shows it: U+2028 breaks a line, U+202E turns text
 * around, C1 controls such as U+0085 act as line feeds in some views.
 */
const ACCOUNT = /^[\x21-\x7e](?:[\x20-\x7e]{0,254}[\x21-\x7e])?$/;
const HASH = /^0x[0-9a-f]{64}$/;
const TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,9})?Z$/;
const NONCE = /^[A-Za-z0-9._~-]{1,128}$/;

function check(fields: MessageFields): void {
  if (!DOMAIN.test(fields.domain)) throw new Error("bad domain");
  if (!ACCOUNT.test(fields.account)) throw new Error("bad account");
  if (!HASH.test(fields.lockHash)) throw new Error("bad lock hash");
  if (!HASH.test(fields.chain)) throw new Error("bad chain");
  if (!TIME.test(fields.issuedAt) || Number.isNaN(Date.parse(fields.issuedAt))) throw new Error("bad issued at");
  if (!NONCE.test(fields.nonce)) throw new Error("bad nonce");
}

/** Builds the proof message. Throws when a field does not fit the format. */
export function message(input: MessageInput): string {
  const fields: MessageFields = {
    domain: input.domain,
    account: input.account,
    lockHash: ccc.Script.from(input.lock).hash(),
    chain: ccc.hexFrom(input.chain),
    issuedAt: input.issuedAt instanceof Date ? input.issuedAt.toISOString() : input.issuedAt,
    nonce: input.nonce,
  };
  check(fields);
  const text = [
    fields.domain + HEADER,
    `Account: ${fields.account}`,
    `Lock hash: ${fields.lockHash}`,
    `Chain: ${fields.chain}`,
    `Issued at: ${fields.issuedAt}`,
    `Nonce: ${fields.nonce}`,
  ].join("\n");
  if (ccc.bytesFrom(text, "utf8").length > MAX_MESSAGE_BYTES) throw new Error("message too long");
  return text;
}

/** Parses a proof message. Throws when the text is not exactly the format of `message()`. */
export function parseMessage(text: string): MessageFields {
  if (ccc.bytesFrom(text, "utf8").length > MAX_MESSAGE_BYTES) throw new Error("message too long");
  const lines = text.split("\n");
  if (lines.length !== 6) throw new Error("expected 6 lines");
  const take = (i: number, prefix: string): string => {
    if (!lines[i].startsWith(prefix)) throw new Error(`line ${i + 1} must start with "${prefix}"`);
    return lines[i].slice(prefix.length);
  };
  if (!lines[0].endsWith(HEADER)) throw new Error("line 1 is not the header");
  const fields: MessageFields = {
    domain: lines[0].slice(0, -HEADER.length),
    account: take(1, "Account: "),
    lockHash: take(2, "Lock hash: ") as ccc.Hex,
    chain: take(3, "Chain: ") as ccc.Hex,
    issuedAt: take(4, "Issued at: "),
    nonce: take(5, "Nonce: "),
  };
  check(fields);
  return fields;
}
