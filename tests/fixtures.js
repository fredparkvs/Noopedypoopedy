// Builds a status block in the layout the light sends after READ_ALL.
function buildStatus({ manual, slots, auto, name, extra = 6 }) {
  const b = [0xab, 0xaa, 0x10, 0x08, ...manual.slice(0, 6), 0x18];
  for (const s of slots) b.push(s.h, s.m, ...s.v.slice(0, 6));
  b.push(auto ? 1 : 0);
  const n = (name + '\0'.repeat(11)).slice(0, 11);
  for (const ch of n) b.push(ch.charCodeAt(0));
  for (let i = 0; i < extra; i++) b.push(0);
  return b;
}

module.exports = { buildStatus };
