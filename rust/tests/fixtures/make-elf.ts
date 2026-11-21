// Writes elf.json: the locks tests/elf.ts assembles, for the Rust tests. Run from the repository root:
//   node rust/tests/fixtures/make-elf.ts
import { writeFileSync } from "node:fs";
import { alwaysSuccess, debuggerSyscall, endlessLoop, headerLock, password, printThen, sinceLock } from "../../../tests/elf.ts";

const hex = (b: Uint8Array) => "0x" + Buffer.from(b).toString("hex");
const out = {
  alwaysSuccess: hex(alwaysSuccess()),
  passwordOpen: hex(password("open")),
  endlessLoop: hex(endlessLoop()),
  debuggerSyscall: hex(debuggerSyscall()),
  since100: hex(sinceLock(100)),
  headerLock: hex(headerLock()),
  printHelloExit0: hex(printThen("hello", 0)),
};
writeFileSync(new URL("./elf.json", import.meta.url), JSON.stringify(out, null, 2) + "\n");
console.log(Object.entries(out).map(([k, v]) => `${k} ${(v.length - 2) / 2} bytes`).join("\n"));
