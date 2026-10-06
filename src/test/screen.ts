// The cells, as far as a test needs them: lines of characters, a cursor,
// and the sequences that move it, erase, insert, delete and scroll. Every
// character is one cell wide; colours and other attributes are dropped.
//
// The main screen's lines grow downward without limit: the rows lines from
// top are on view, and those above them are the scrollback. The alternate
// screen (fixed) is rows lines, and what scrolls off it is lost.

export class Screen {
  lines: string[][] = [];
  wraps: boolean[] = []; // wraps[i]: line i goes on from line i-1, which the cursor wrapped off
  top = 0; // the first line on view
  col = 0;
  row = 0; // the cursor; row is an index in lines
  saved: [number, number] = [0, 0]; // DECSC: the cursor's column and row on view
  margins: [number, number] = [0, 0]; // DECSTBM: the region's first and last rows on view; both 0 for all of them
  last = ""; // the last character put, for REP

  readonly cols: number;
  readonly rows: number;
  readonly fixed: boolean;

  constructor(cols: number, rows: number, fixed = false) {
    this.cols = cols;
    this.rows = rows;
    this.fixed = fixed;
  }

  // The cursor's line, made if it was not yet.
  line(): string[] {
    return this.lineAt(this.row);
  }

  lineAt(i: number): string[] {
    while (this.lines.length <= i) {
      this.lines.push([]);
      this.wraps.push(false);
    }
    return this.lines[i]!;
  }

  put(ch: string) {
    if (this.col >= this.cols) {
      this.index();
      this.col = 0;
      this.wraps[this.row] = true;
    }
    const l = this.line();
    while (l.length < this.col) l.push(" ");
    l[this.col] = ch;
    this.col++;
    this.last = ch;
  }

  control(c: number) {
    switch (c) {
      case 0x0d:
        this.col = 0;
        break;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        // A terminal maps LF to CR LF when it is not raw (ONLCR); a program
        // in raw mode writes CR LF itself. Either way a line starts.
        this.index();
        this.col = 0;
        break;
      case 0x08:
        this.col = Math.max(0, Math.min(this.col, this.cols - 1) - 1);
        break;
      case 0x09:
        this.col = Math.min((Math.floor(this.col / 8) + 1) * 8, this.cols - 1);
        break;
    }
  }

  // The scrolling region's first and last rows on view.
  region(): [number, number] {
    if (this.margins[0] === 0 && this.margins[1] === 0) return [0, this.rows - 1];
    return this.margins;
  }

  // IND: down a row, scrolling the region up at its last row.
  index() {
    const [, last] = this.region();
    const v = this.row - this.top;
    if (v === last) this.scrollUp(1);
    else if (v < this.rows - 1) this.row++;
    this.line();
  }

  // RI: up a row, scrolling the region down at its first.
  reverseIndex() {
    const [first] = this.region();
    const v = this.row - this.top;
    if (v === first) this.scrollDown(1);
    else if (v > 0) this.row--;
  }

  // Moves the region's lines up n rows. On the main screen, when the region
  // is all of it, the lines leave the view for the scrollback, and the
  // cursor stays on its row on view.
  scrollUp(n: number) {
    const [first, last] = this.region();
    if (!this.fixed && first === 0 && last === this.rows - 1) {
      this.top += n;
      this.row += n;
      this.lineAt(this.top + this.rows - 1);
      return;
    }
    this.deleteLines(this.top + first, this.top + last, n);
  }

  scrollDown(n: number) {
    const [first, last] = this.region();
    this.insertLines(this.top + first, this.top + last, n);
  }

  // Inserts n blank lines at line a, in the lines a to b: those pushed past
  // b are lost.
  insertLines(a: number, b: number, n: number) {
    this.lineAt(b);
    n = Math.min(n, b - a + 1);
    for (let i = b; i >= a + n; i--) {
      this.lines[i] = this.lines[i - n]!;
      this.wraps[i] = this.wraps[i - n]!;
    }
    for (let i = a; i < a + n; i++) this.clear(i);
  }

  // Deletes n lines at line a, in the lines a to b: blank lines come in at b.
  deleteLines(a: number, b: number, n: number) {
    this.lineAt(b);
    n = Math.min(n, b - a + 1);
    for (let i = a; i <= b - n; i++) {
      this.lines[i] = this.lines[i + n]!;
      this.wraps[i] = this.wraps[i + n]!;
    }
    for (let i = b + 1 - n; i <= b; i++) this.clear(i);
  }

  // Puts the cursor at a row on view and a column, within the screen.
  moveTo(row: number, col: number) {
    this.row = this.top + Math.min(Math.max(row, 0), this.rows - 1);
    this.col = Math.min(Math.max(col, 0), this.cols - 1);
    this.line();
  }

  // Blanks line i whole: what is written there next is a line of its own.
  clear(i: number) {
    this.lines[i] = [];
    this.wraps[i] = false;
  }

  // Blanks the cursor's line from column a to before b.
  erase(a: number, b: number) {
    const l = this.line();
    if (b >= l.length) {
      l.length = Math.min(a, l.length);
      if (a === 0) this.wraps[this.row] = false;
      return;
    }
    for (let i = a; i < b; i++) l[i] = " ";
  }

  // The CSI sequences that move the cursor, erase, insert, delete and scroll.
  csi(params: string, final: string) {
    if (/^[?>=<]/.test(params)) return;
    const nums = params.split(";").map((p) => Number.parseInt(p, 10) || 0);
    const arg = (i: number, def: number) => (i < nums.length && nums[i]! > 0 ? nums[i]! : def);
    const n = arg(0, 1);
    this.line();
    const v = this.row - this.top; // the cursor's row on view
    switch (final) {
      case "A":
        this.moveTo(v - n, this.col);
        break;
      case "B":
      case "e":
        this.moveTo(v + n, this.col);
        break;
      case "C":
      case "a":
        this.moveTo(v, this.col + n);
        break;
      case "D":
        this.moveTo(v, Math.min(this.col, this.cols - 1) - n);
        break;
      case "E":
        this.moveTo(v + n, 0);
        break;
      case "F":
        this.moveTo(v - n, 0);
        break;
      case "G":
      case "`":
        this.moveTo(v, n - 1);
        break;
      case "d":
        this.moveTo(n - 1, this.col);
        break;
      case "H":
      case "f":
        this.moveTo(arg(0, 1) - 1, arg(1, 1) - 1);
        break;
      case "I":
        this.col = Math.min((Math.floor(this.col / 8) + n) * 8, this.cols - 1);
        break;
      case "K":
        switch (arg(0, 0)) {
          case 0:
            this.erase(this.col, this.cols);
            break;
          case 1:
            this.erase(0, this.col + 1);
            break;
          case 2:
            this.clear(this.row);
            break;
        }
        break;
      case "J":
        switch (arg(0, 0)) {
          case 0:
            this.erase(this.col, this.cols);
            for (let i = this.row + 1; i < Math.min(this.lines.length, this.top + this.rows); i++) this.clear(i);
            break;
          case 1:
            this.erase(0, this.col + 1);
            for (let i = this.top; i < this.row; i++) this.clear(i);
            break;
          case 2:
            for (let i = this.top; i < Math.min(this.lines.length, this.top + this.rows); i++) this.clear(i);
            break;
          case 3:
            this.lines = this.lines.slice(this.top);
            this.wraps = this.wraps.slice(this.top);
            this.row -= this.top;
            this.top = 0;
            break;
        }
        break;
      case "X":
        this.erase(this.col, Math.min(this.col + n, this.cols));
        break;
      case "@": {
        const l = this.line();
        if (this.col < l.length) {
          l.splice(this.col, 0, ...Array<string>(n).fill(" "));
          l.length = Math.min(l.length, this.cols);
        }
        break;
      }
      case "P": {
        const l = this.line();
        if (this.col < l.length) l.splice(this.col, Math.min(n, l.length - this.col));
        break;
      }
      case "L":
      case "M": {
        const [first, last] = this.region();
        if (v >= first && v <= last) {
          if (final === "L") this.insertLines(this.row, this.top + last, n);
          else this.deleteLines(this.row, this.top + last, n);
          this.col = 0;
        }
        break;
      }
      case "S":
        this.scrollUp(n);
        break;
      case "T":
        this.scrollDown(n);
        break;
      case "b":
        if (this.last) for (let i = 0; i < Math.min(n, this.cols * this.rows); i++) this.put(this.last);
        break;
      case "r": {
        const first = arg(0, 1) - 1;
        const last = arg(1, this.rows) - 1;
        if (first < last && last < this.rows) {
          this.margins = first === 0 && last === this.rows - 1 ? [0, 0] : [first, last];
          this.moveTo(0, 0);
        }
        break;
      }
      case "s":
        if (params === "") this.save();
        break;
      case "u":
        this.restore();
        break;
    }
    this.line();
  }

  // DECSC: the cursor's place on view.
  save() {
    this.saved = [this.col, this.row - this.top];
  }

  // DECRC.
  restore() {
    this.moveTo(this.saved[1], this.saved[0]);
  }

  // The screen's text as lines were written: a row the cursor wrapped onto
  // joined to the one before it, trailing spaces and empty lines at the end
  // left out.
  logical(): string[] {
    const out: string[] = [];
    let cur: string[] = [];
    let row = 0; // where the last row starts in cur
    this.lines.forEach((l, i) => {
      if (i > 0 && this.wraps[i]) {
        // The row before was full when the cursor wrapped off it.
        while (cur.length < row + this.cols) cur.push(" ");
      } else if (i > 0) {
        out.push(cur.join("").trimEnd());
        cur = [];
      }
      row = cur.length;
      cur.push(...l.map((c) => c ?? " "));
    });
    if (this.lines.length > 0) out.push(cur.join("").trimEnd());
    while (out.length > 0 && out.at(-1) === "") out.pop();
    return out;
  }

  // The screen as text: a line a row, trailing spaces and empty rows at the
  // end left out.
  toString(): string {
    return this.lines
      .map((l) => Array.from(l, (c) => c ?? " ").join("").trimEnd())
      .join("\n")
      .replace(/\n+$/, "");
  }
}
