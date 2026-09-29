// @inhuman.tools/arrival/r7rs/host — R7RS §6.13 / §6.14 doors-only.
// Pure inference plane: no ports, no ambient system. implement-or-door totalized.
// call-with-input-string lives in srfi-stubs (SRFI-6).
import { EnvCapability } from "../../common/capability.js";

const IO =
  "ports & IO are omitted from arrival by design — it is a pure inference plane with no IO surface; an ambient read/write has no value-construction site for provenance. Return the value from your dataflow instead of streaming it out";
const SYSTEM =
  "the system interface is omitted from arrival by design — clock, environment, command line, features and exit are ambient and non-deterministic, with no construction-site to root a value's lineage at; pass any context you need in explicitly";
const FILE =
  'no file ports in this sandbox — files arrive through tools, not streams; call the filesystem tool bound in this environment (e.g. (filesystem/read_file :path "...")) and use the returned value directly';

/** name → reason. Sole inventory; symbols + HOST_DOOR_NAMES derive from this. */
const DOORS = {
  "port?": IO,
  "input-port?": IO,
  "output-port?": IO,
  "textual-port?": IO,
  "binary-port?": IO,
  "input-port-open?": IO,
  "output-port-open?": IO,
  "close-port": IO,
  "close-input-port": IO,
  "close-output-port": IO,
  "call-with-port": IO,
  "current-input-port": IO,
  "current-output-port": IO,
  "current-error-port": IO,
  "open-input-string": IO,
  "open-output-string": IO,
  "get-output-string": IO,
  "open-input-bytevector": IO,
  "open-output-bytevector": IO,
  "get-output-bytevector": IO,
  "call-with-input-file": FILE,
  "call-with-output-file": FILE,
  "with-input-from-file": FILE,
  "with-output-to-file": FILE,
  "open-input-file": FILE,
  "open-output-file": FILE,
  "open-binary-input-file": FILE,
  "open-binary-output-file": FILE,
  "eof-object": IO,
  "eof-object?": IO,
  read: IO,
  "read-char": IO,
  "peek-char": IO,
  "read-line": IO,
  "read-string": IO,
  "read-u8": IO,
  "peek-u8": IO,
  "read-bytevector": IO,
  "read-bytevector!": IO,
  "char-ready?": IO,
  "u8-ready?": IO,
  write: IO,
  "write-shared": IO,
  "write-simple": IO,
  display: IO,
  newline: IO,
  "write-char": IO,
  "write-string": IO,
  "write-u8": IO,
  "write-bytevector": IO,
  "flush-output-port": IO,
  "file-exists?": FILE,
  "delete-file": FILE,
  load: FILE,
  "command-line": SYSTEM,
  exit: SYSTEM,
  "emergency-exit": SYSTEM,
  "get-environment-variable": SYSTEM,
  "get-environment-variables": SYSTEM,
  "current-second": SYSTEM,
  "current-jiffy": SYSTEM,
  "jiffies-per-second": SYSTEM,
  features: SYSTEM,
} as const satisfies Record<string, string>;

export const HOST_DOOR_NAMES = Object.keys(DOORS) as (keyof typeof DOORS)[];

export default EnvCapability.define("scheme/r7rs/host", {
  symbols: (symbol) =>
    Object.fromEntries(
      Object.entries(DOORS).map(([name, reason]) => [name, symbol.notImplemented`${name}: ${reason}`]),
    ),
});
