// Tiny RISC-V (RV64I) programs for tests, assembled here so no binary is kept in the repo.
// Each is a whole ELF that CKB-VM loads as a lock: an always-success lock, an endless loop, a lock
// that opens with a fixed witness (like a hash lock whose preimage is public), and locks that
// print through the debug syscall before they exit or crash.

const ZERO = 0, SP = 2, T0 = 5, T1 = 6, A0 = 10, A1 = 11, A2 = 12, A3 = 13, A4 = 14, A5 = 15, A7 = 17;
const SYS_EXIT = 93;
const SYS_LOAD_WITNESS = 2074;
const SYS_LOAD_INPUT_BY_FIELD = 2073;
const SYS_LOAD_HEADER = 2072;
const SYS_DEBUG = 2177;
const SOURCE_INPUT = 1;
const SOURCE_HEADER_DEP = 4;
const FIELD_SINCE = 0;

type Item = number | { label: string } | { op: "bne" | "bltu"; rs1: number; rs2: number; to: string } | { op: "jal"; to: string };

const iType = (opcode: number, f3: number, rd: number, rs1: number, imm: number) => (((imm & 0xfff) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opcode) >>> 0;
const addi = (rd: number, rs1: number, imm: number) => iType(0x13, 0, rd, rs1, imm);
const ld = (rd: number, rs1: number, imm: number) => iType(0x03, 3, rd, rs1, imm);
const lwu = (rd: number, rs1: number, imm: number) => iType(0x03, 6, rd, rs1, imm);
const sd = (rs2: number, rs1: number, imm: number) => ((((imm >> 5) & 0x7f) << 25) | (rs2 << 20) | (rs1 << 15) | (3 << 12) | ((imm & 0x1f) << 7) | 0x23) >>> 0;
const lui = (rd: number, imm20: number) => (((imm20 & 0xfffff) << 12) | (rd << 7) | 0x37) >>> 0;
const auipc = (rd: number, imm20: number) => (((imm20 & 0xfffff) << 12) | (rd << 7) | 0x17) >>> 0;
const ECALL = 0x73;
/** An instruction word that is not a valid RISC-V instruction. */
const ILLEGAL = 0x00000000;

const bne = (rs1: number, rs2: number, off: number) =>
  ((((off >> 12) & 1) << 31) | (((off >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (1 << 12) | (((off >> 1) & 0xf) << 8) | (((off >> 11) & 1) << 7) | 0x63) >>> 0;
const bltu = (rs1: number, rs2: number, off: number) =>
  ((((off >> 12) & 1) << 31) | (((off >> 5) & 0x3f) << 25) | (rs2 << 20) | (rs1 << 15) | (6 << 12) | (((off >> 1) & 0xf) << 8) | (((off >> 11) & 1) << 7) | 0x63) >>> 0;
const jal = (rd: number, off: number) =>
  ((((off >> 20) & 1) << 31) | (((off >> 1) & 0x3ff) << 21) | (((off >> 11) & 1) << 20) | (((off >> 12) & 0xff) << 12) | (rd << 7) | 0x6f) >>> 0;

/** rd = value, for 0 <= value < 2^31. */
function li(rd: number, value: number): number[] {
  if (value >= -2048 && value < 2048) return [addi(rd, ZERO, value)];
  const lo = ((value & 0xfff) ^ 0x800) - 0x800;
  return [lui(rd, (value - lo) >>> 12), addi(rd, rd, lo)];
}

function assemble(items: Item[]): Uint8Array {
  const labels = new Map<string, number>();
  let pc = 0;
  for (const it of items) {
    if (typeof it === "object" && "label" in it) labels.set(it.label, pc);
    else pc += 4;
  }
  const words: number[] = [];
  for (const it of items) {
    if (typeof it === "number") words.push(it);
    else if ("op" in it) {
      const off = labels.get(it.to)! - words.length * 4;
      words.push(it.op === "jal" ? jal(ZERO, off) : it.op === "bltu" ? bltu(it.rs1, it.rs2, off) : bne(it.rs1, it.rs2, off));
    }
  }
  const out = new Uint8Array(words.length * 4);
  const view = new DataView(out.buffer);
  words.forEach((w, i) => view.setUint32(i * 4, w, true));
  return out;
}

/** A minimal ELF64 for RISC-V: one loadable segment holding the code (and any data after it). */
function elf(code: Uint8Array): Uint8Array {
  const base = 0x10000;
  const hdr = 64 + 56;
  const total = hdr + code.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  v.setUint16(16, 2, true); // ET_EXEC
  v.setUint16(18, 243, true); // EM_RISCV
  v.setUint32(20, 1, true);
  v.setBigUint64(24, BigInt(base + hdr), true); // entry
  v.setBigUint64(32, 64n, true); // phoff
  v.setUint16(52, 64, true);
  v.setUint16(54, 56, true);
  v.setUint16(56, 1, true);
  v.setUint16(58, 64, true);
  v.setUint32(64, 1, true); // PT_LOAD
  v.setUint32(68, 5, true); // R + X
  v.setBigUint64(80, BigInt(base), true);
  v.setBigUint64(88, BigInt(base), true);
  v.setBigUint64(96, BigInt(total), true);
  v.setBigUint64(104, BigInt(total), true);
  v.setBigUint64(112, 0x1000n, true);
  out.set(code, hdr);
  return out;
}

const exit = (code: number) => [...li(A0, code), ...li(A7, SYS_EXIT), ECALL];

/** Exits 0 whatever the transaction: anyone can open it. */
export const alwaysSuccess = () => elf(assemble(exit(0)));

/**
 * Calls syscall 9001, which ckb-debugger adds for development (no node has it), then exits 0.
 * ckb-debugger runs it to exit 0; a node's VM stops at the unknown syscall.
 */
export const debuggerSyscall = () => elf(assemble([...li(A7, 9001), ECALL, ...exit(0)]));

/** Never stops: only the cycle limit ends it. */
export const endlessLoop = () => elf(assemble([{ label: "top" }, { op: "jal", to: "top" }]));

/**
 * Prints `text` with the debug syscall, then exits with `code`, or runs an illegal instruction
 * when `code` is "crash". The text may hold line feeds, so it can imitate the debugger's own lines.
 */
export function printThen(text: string, code: number | "crash"): Uint8Array {
  const msg = new TextEncoder().encode(text);
  const tail = code === "crash" ? [ILLEGAL] : exit(code);
  const words = 2 + li(A7, SYS_DEBUG).length + 1 + tail.length;
  const prog = assemble([auipc(A0, 0), addi(A0, A0, words * 4), ...li(A7, SYS_DEBUG), ECALL, ...tail]);
  const out = new Uint8Array(prog.length + msg.length + 1);
  out.set(prog);
  out.set(msg, prog.length);
  return elf(out);
}

/**
 * Exits 0 when witness 0 is exactly the 4 ASCII bytes of `word`, else 1, 2 or 3. The witness does
 * not commit to the transaction, so anyone who has seen it once can reuse it on another message.
 */
export function password(word: string): Uint8Array {
  const b = new TextEncoder().encode(word);
  if (b.length !== 4 || b.some((x) => x >= 0x80)) throw new Error("4 ASCII bytes");
  const want = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
  return elf(
    assemble([
      addi(SP, SP, -80),
      ...li(T0, 64),
      sd(T0, SP, 0),
      addi(A0, SP, 8),
      addi(A1, SP, 0),
      ...li(A2, 0),
      ...li(A3, 0),
      ...li(A4, SOURCE_INPUT),
      ...li(A7, SYS_LOAD_WITNESS),
      ECALL,
      { op: "bne", rs1: A0, rs2: ZERO, to: "fail1" },
      ld(T0, SP, 0),
      ...li(T1, 4),
      { op: "bne", rs1: T0, rs2: T1, to: "fail2" },
      lwu(T0, SP, 8),
      ...li(T1, want),
      { op: "bne", rs1: T0, rs2: T1, to: "fail3" },
      ...exit(0),
      { label: "fail1" },
      ...exit(1),
      { label: "fail2" },
      ...exit(2),
      { label: "fail3" },
      ...exit(3),
    ]),
  );
}

/**
 * Exits 0 when input 0's since (u64 little-endian) is >= `min`, else 24; 11 if the syscall fails.
 * Stands in for a lock with an absolute time condition, to show the verifier can carry a satisfying
 * since. Like a hash lock, it reads no signature, so the probes refuse it on its own.
 */
export function sinceLock(min: number): Uint8Array {
  return elf(
    assemble([
      addi(SP, SP, -80),
      ...li(T0, 8),
      sd(T0, SP, 0),
      addi(A0, SP, 8),
      addi(A1, SP, 0),
      ...li(A2, 0),
      ...li(A3, 0),
      ...li(A4, SOURCE_INPUT),
      ...li(A5, FIELD_SINCE),
      ...li(A7, SYS_LOAD_INPUT_BY_FIELD),
      ECALL,
      { op: "bne", rs1: A0, rs2: ZERO, to: "fail_syscall" },
      ld(T0, SP, 8),
      ...li(T1, min),
      { op: "bltu", rs1: T0, rs2: T1, to: "fail_since" },
      ...exit(0),
      { label: "fail_syscall" },
      ...exit(11),
      { label: "fail_since" },
      ...exit(24),
    ]),
  );
}

/**
 * Exits 0 when header dep 0 loads, else 7. Stands in for a lock that reads a header, to show the
 * verifier can carry and resolve header deps. Reads no signature, so the probes refuse it on its own.
 */
export function headerLock(): Uint8Array {
  return elf(
    assemble([
      addi(SP, SP, -240),
      ...li(T0, 208),
      sd(T0, SP, 0),
      addi(A0, SP, 8),
      addi(A1, SP, 0),
      ...li(A2, 0),
      ...li(A3, 0),
      ...li(A4, SOURCE_HEADER_DEP),
      ...li(A7, SYS_LOAD_HEADER),
      ECALL,
      { op: "bne", rs1: A0, rs2: ZERO, to: "fail" },
      ...exit(0),
      { label: "fail" },
      ...exit(7),
    ]),
  );
}
