// osc — terminal-feature emitters. Assertions pin the escape structure (the bytes a
// terminal keys on); `\e` shown as its literal in the regexes.
import { describe, expect, it } from "vitest";

import {
  clipboardSet,
  commandDone,
  COMMAND_START,
  curlyUnderline,
  extractOsc10FromBuffer,
  extractOsc11FromBuffer,
  fileUrl,
  hyperlink,
  notify,
  OSC10_QUERY,
  OSC11_QUERY,
  parseOscColorPayload,
  PROMPT_START,
} from "../osc.js";

const E = "\x1b";

describe("hyperlink (OSC 8)", () => {
  it("wraps text in the OSC-8 open/close, carrying the url", () => {
    const link = hyperlink("https://x.test", "click");
    expect(link).toBe(`${E}]8;;https://x.test${E}\\click${E}]8;;${E}\\`);
  });
  it("the visible text is exactly the payload (terminals without OSC-8 show it bare)", () => {
    // strip the OSC-8 wrappers → the plain text remains
    const bare = hyperlink("u", "the-text").replace(/\x1b\]8;[^\x1b]*\x1b\\/g, "");
    expect(bare).toBe("the-text");
  });
  it("id groups a multi-run link", () => {
    expect(hyperlink("u", "t", "abc")).toContain("8;id=abc;u");
  });
});

describe("fileUrl", () => {
  it("builds a file:// url with an optional line", () => {
    expect(fileUrl("/a/b.scm")).toBe("file:///a/b.scm");
    expect(fileUrl("/a/b.scm", 16)).toBe("file:///a/b.scm:16");
  });
});

describe("OSC 133 marks", () => {
  it("emits the FinalTerm A/C/D sequences", () => {
    expect(PROMPT_START).toBe(`${E}]133;A${E}\\`);
    expect(COMMAND_START).toBe(`${E}]133;C${E}\\`);
    expect(commandDone(0)).toBe(`${E}]133;D;0${E}\\`);
    expect(commandDone(1)).toBe(`${E}]133;D;1${E}\\`);
  });
});

describe("clipboardSet (OSC 52)", () => {
  it("base64-encodes the payload into an OSC-52 set", () => {
    const seq = clipboardSet("hi");
    expect(seq).toBe(`${E}]52;c;${Buffer.from("hi").toString("base64")}${E}\\`);
    // round-trips
    const b64 = seq.slice(seq.indexOf(";c;") + 3, seq.indexOf(`${E}\\`));
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe("hi");
  });
});

describe("notify (OSC 9)", () => {
  it("wraps the message, BEL-terminated", () => {
    expect(notify("done")).toBe(`${E}]9;done\x07`);
  });
});

describe("curlyUnderline (SGR 4:3)", () => {
  it("opens 4:3, closes 4:0; adds/clears color when given rgb", () => {
    expect(curlyUnderline("x")).toBe(`${E}[4:3mx${E}[4:0m`);
    expect(curlyUnderline("x", [255, 0, 0])).toBe(`${E}[4:3m${E}[58:2::255:0:0mx${E}[4:0m${E}[59m`);
  });
});

describe("OSC 10/11 canvas payload", () => {
  it("emits the BEL-terminated queries", () => {
    expect(OSC11_QUERY).toBe(`${E}]11;?\x07`);
    expect(OSC10_QUERY).toBe(`${E}]10;?\x07`);
  });

  it("parses XParseColor rgb:rrrr/gggg/bbbb (4-digit and 2-digit)", () => {
    expect(parseOscColorPayload("rgb:0000/0000/0000")).toEqual({ r: 0, g: 0, b: 0 });
    expect(parseOscColorPayload("rgb:ffff/ffff/ffff")).toEqual({ r: 255, g: 255, b: 255 });
    expect(parseOscColorPayload("rgb:12/34/56")).toEqual({
      r: Math.round((0x12 / 0xff) * 255),
      g: Math.round((0x34 / 0xff) * 255),
      b: Math.round((0x56 / 0xff) * 255),
    });
  });

  it("parses #rrggbb and bare rrggbb", () => {
    expect(parseOscColorPayload("#1a2b3c")).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c });
    expect(parseOscColorPayload("1a2b3c")).toEqual({ r: 0x1a, g: 0x2b, b: 0x3c });
  });

  it("returns null for garbage", () => {
    expect(parseOscColorPayload("not-a-color")).toBeNull();
  });

  it("extracts a BEL- or ST-terminated payload and refuses an unterminated fragment", () => {
    expect(extractOsc11FromBuffer(`${E}]11;rgb:0000/0000/0000\x07`)).toBe("rgb:0000/0000/0000");
    expect(extractOsc11FromBuffer(`${E}]11;rgb:1111/2222/3333${E}\\`)).toBe("rgb:1111/2222/3333");
    expect(extractOsc11FromBuffer(`${E}]11;rgb:1`)).toBeNull();
    expect(extractOsc10FromBuffer(`${E}]10;rgb:eeee/eeee/eeee\x07`)).toBe("rgb:eeee/eeee/eeee");
    expect(extractOsc10FromBuffer(`${E}]11;rgb:eeee/eeee/eeee\x07`)).toBeNull();
  });
});
