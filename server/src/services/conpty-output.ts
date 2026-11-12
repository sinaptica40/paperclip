// Windows ConPTY redraws the screen instead of streaming text: it moves to a new
// row with an absolute cursor position (`ESC[22;1H`) and skips spaces with a
// cursor-forward move (`ESC[1C`). The sign-in prompt parser reads lines of text,
// so it never sees the URL on its own line. This puts the two moves back into
// the line breaks and spaces they stand for. It only reshapes whitespace; every
// other byte passes through unchanged.
//
// Claude prints its sign-in URL as an OSC 8 hyperlink, and ConPTY moves the
// cursor right after the hyperlink opens. The parser reads a whole hyperlink as
// one unit, so the line break has to go in front of the hyperlink, never inside it.

// A hyperlink opener has a non-empty URI; the closer (`ESC]8;;ST`) has none.
const OSC8_OPEN = "\u001b\\]8;[^;\\u0007\\u001b]*;[^\\u0007\\u001b]+(?:\\u0007|\\u001b\\\\)";
const CURSOR_MOVE = "\\u001b\\[\\d*(?:;\\d*)?[HC]";
const OPEN_THEN_MOVES = new RegExp(`(${OSC8_OPEN})((?:${CURSOR_MOVE})+)`, "g");
const MOVE = new RegExp(CURSOR_MOVE, "g");
const CURSOR_POSITION = /^\u001b\[(\d*)(?:;(\d*))?H$/;
const CURSOR_FORWARD = /^\u001b\[(\d*)C$/;
// Kept for the next chunk: an escape sequence cut off at the end of this one, or a
// hyperlink opener that a cursor move may still follow.
const HELD_TAIL = new RegExp(
  `(?:${OSC8_OPEN}(?:${CURSOR_MOVE})*(?:\\u001b\\[[0-9;?]*|\\u001b)?|\\u001b\\][^\\u0007\\u001b]*\\u001b?|\\u001b\\[[0-9;?]*|\\u001b)$`,
);

export function createConPtyOutputNormalizer(): (chunk: string) => string {
  let pending = "";
  let row = 0;
  const move = (sequence: string): string => {
    const position = CURSOR_POSITION.exec(sequence);
    if (position) {
      const next = Number(position[1] || 1);
      const moved = next !== row;
      row = next;
      return moved ? "\n" : "";
    }
    const forward = CURSOR_FORWARD.exec(sequence);
    return forward ? " ".repeat(Number(forward[1] || 1)) : sequence;
  };
  return (chunk) => {
    let text = pending + chunk;
    pending = "";
    const tail = HELD_TAIL.exec(text);
    if (tail) {
      pending = tail[0];
      text = text.slice(0, tail.index);
    }
    // Hyperlink opener followed by cursor moves: apply the moves first, so any
    // line break lands before the opener.
    return text
      .replace(OPEN_THEN_MOVES, (_all, opener: string, moves: string) => moves.replace(MOVE, move) + opener)
      .replace(MOVE, move);
  };
}
