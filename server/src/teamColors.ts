/** Distinct car colours, handed out in join order. */
const PALETTE = ["#e6194b", "#3cb44b", "#4363d8", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4", "#469990"];

export function colorFor(index: number) {
  return PALETTE[index % PALETTE.length];
}
