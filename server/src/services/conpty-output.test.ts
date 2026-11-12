import { describe, expect, it } from "vitest";
import { parseSetupTokenPrompt } from "@paperclipai/adapter-claude-local/server";
import { createConPtyOutputNormalizer } from "./conpty-output.js";

describe("ConPTY output normalizer", () => {
  it("turns a cursor jump to a new row into a line break", () => {
    const normalize = createConPtyOutputNormalizer();
    const text = normalize("sign in (c to copy)\u001b[22;1Hhttps://claude.com/cai/oauth/authorize?x=1\u001b[23;1HPaste code here if prompted >");
    expect(text).toBe("sign in (c to copy)\nhttps://claude.com/cai/oauth/authorize?x=1\nPaste code here if prompted >");
  });

  it("does not break the line when the cursor stays on the same row", () => {
    const normalize = createConPtyOutputNormalizer();
    expect(normalize("a\u001b[5;1Hb\u001b[5;9Hc")).toBe("a\nbc");
  });

  it("turns cursor-forward moves into spaces", () => {
    const normalize = createConPtyOutputNormalizer();
    expect(normalize("Welcome\u001b[1Cto\u001b[2CClaude")).toBe("Welcome to  Claude");
  });

  it("keeps an escape sequence that is split across two chunks", () => {
    const normalize = createConPtyOutputNormalizer();
    const first = normalize("one\u001b[7;");
    const second = normalize("1Htwo");
    expect(first + second).toBe("one\ntwo");
  });

  it("puts the line break before a hyperlink, not inside it, so the sign-in prompt parses", () => {
    const url = "https://claude.com/cai/oauth/authorize?client_id=cid&code=abcdefgh&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&response_type=code&scope=user&state=0123456789abcdef";
    const stream = [
      "Browser didn't open? Use the url below to sign in (c to copy)",
      `\u001b]8;id=u-1;${url}\u001b\\`, "\u001b[22;1H", url, "\u001b]8;;\u001b\\",
      "\u001b[23;1H", "Paste code here if prompted >",
    ].join("");
    const normalize = createConPtyOutputNormalizer();
    // Feed it in odd-sized pieces: a real terminal splits the stream anywhere.
    let output = "";
    for (let i = 0; i < stream.length; i += 7) output += normalize(stream.slice(i, i + 7));
    expect(parseSetupTokenPrompt(output)?.url).toBe(url);
  });

  it("leaves other terminal sequences and ordinary text untouched", () => {
    const normalize = createConPtyOutputNormalizer();
    expect(normalize("\u001b[38;2;1;2;3mcolor\u001b[m\r\nline")).toBe("\u001b[38;2;1;2;3mcolor\u001b[m\r\nline");
  });
});
