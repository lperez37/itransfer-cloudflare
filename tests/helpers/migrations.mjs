/** Split SQLite migrations without breaking trigger bodies, CASE, quoted
 * semicolons or comments. D1.exec splits on newlines; prepare().run() does not.
 * This is intentionally a statement lexer, not a SQL formatter/parser. */
export function migrationStatements(sql) {
  const tokens = sql.match(/--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|[A-Za-z_][A-Za-z_0-9]*|[^]/g) ?? [];
  const result = [];
  let text = '', words = [], trigger = false, depth = 0;
  for (const token of tokens) {
    if (token.startsWith('--') || token.startsWith('/*')) { text += ' '; continue; }
    text += token;
    if (/^[A-Za-z_][A-Za-z_0-9]*$/.test(token)) {
      const word = token.toUpperCase();
      words.push(word);
      if (words[0] === 'CREATE' && word === 'TRIGGER' && words.length <= 3) trigger = true;
      if (trigger && (word === 'BEGIN' || word === 'CASE')) depth++;
      if (trigger && word === 'END') depth--;
    }
    if (token === ';' && depth === 0) {
      if (text.trim()) result.push(text.trim());
      text = ''; words = []; trigger = false;
    }
  }
  if (depth !== 0) throw new Error('Unterminated migration trigger');
  if (text.trim()) result.push(text.trim());
  return result;
}
