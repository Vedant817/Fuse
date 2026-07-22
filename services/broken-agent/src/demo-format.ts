/**
 * Minimal ANSI terminal formatting for demo.ts — no dependency added for
 * this, since it's a handful of escape codes used only by a demo script,
 * never by production code. Honors NO_COLOR (https://no-color.org) and
 * disables color automatically when stdout isn't a TTY (e.g. piped to a
 * file or CI log).
 */
const COLOR_ENABLED = process.stdout.isTTY && !process.env['NO_COLOR'];

const CODES = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
} as const;

function paint(code: keyof typeof CODES, text: string): string {
  return COLOR_ENABLED ? `${CODES[code]}${text}${CODES.reset}` : text;
}

export const bold = (s: string): string => paint('bold', s);
export const dim = (s: string): string => paint('dim', s);
export const red = (s: string): string => paint('red', s);
export const green = (s: string): string => paint('green', s);
export const yellow = (s: string): string => paint('yellow', s);
export const blue = (s: string): string => paint('blue', s);
export const magenta = (s: string): string => paint('magenta', s);
export const cyan = (s: string): string => paint('cyan', s);

const WIDTH = 72;

export function banner(title: string, subtitle?: string): void {
  const line = '═'.repeat(WIDTH);
  console.log('\n' + cyan(line));
  console.log(cyan('║ ') + bold(title));
  if (subtitle) console.log(cyan('║ ') + dim(subtitle));
  console.log(cyan(line));
}

let actNumber = 0;
export function act(title: string): void {
  actNumber += 1;
  const label = ` ACT ${actNumber}: ${title} `;
  const pad = Math.max(0, WIDTH - label.length);
  const left = '─'.repeat(Math.floor(pad / 2));
  const right = '─'.repeat(pad - Math.floor(pad / 2));
  console.log('\n' + magenta(`${left}${label}${right}`));
}

export function ok(msg: string): void {
  console.log(`  ${green('✓')} ${msg}`);
}

export function fail(msg: string): void {
  console.log(`  ${red('✗')} ${msg}`);
}

export function info(msg: string): void {
  console.log(`  ${cyan('→')} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`  ${yellow('!')} ${msg}`);
}

export function kv(label: string, value: string | number | boolean): void {
  console.log(`    ${dim(label.padEnd(22))} ${bold(String(value))}`);
}

export function round(
  index: number,
  role: string,
  content: string,
  inputTokens: number,
  outputTokens: number,
): void {
  const roleLabel = role === 'analyzer' ? blue('analyzer') : magenta('verifier');
  const truncated = content.length > 60 ? content.slice(0, 57) + '...' : content;
  console.log(
    `    ${dim(`#${index}`.padStart(3))} ${roleLabel.padEnd(18)} ` +
      `${dim(`(${inputTokens}in/${outputTokens}out)`.padEnd(14))} ${truncated}`,
  );
}

export function summaryBox(lines: string[]): void {
  const line = '─'.repeat(WIDTH);
  console.log('\n' + green(line));
  console.log(green('║ ') + bold('SUMMARY'));
  for (const l of lines) console.log(green('║ ') + l);
  console.log(green(line));
}

export function fatal(msg: string, hint?: string[]): never {
  console.error('\n' + red('✗ ' + msg));
  if (hint) {
    for (const h of hint) console.error('  ' + dim(h));
  }
  process.exit(1);
}
