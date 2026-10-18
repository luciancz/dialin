/** Small dense matrices as number[][] (row-major). Sizes are tiny (≤ ~20), so clarity wins. */

export type Mat = number[][];
export type Vec = number[];

export function zeros(n: number, m: number): Mat {
  return Array.from({ length: n }, () => new Array<number>(m).fill(0));
}

export function identity(n: number): Mat {
  const I = zeros(n, n);
  for (let i = 0; i < n; i++) (I[i] as number[])[i] = 1;
  return I;
}

export function diag(values: readonly number[]): Mat {
  const D = zeros(values.length, values.length);
  for (let i = 0; i < values.length; i++) (D[i] as number[])[i] = values[i] ?? 0;
  return D;
}

export function clone(A: Mat): Mat {
  return A.map((r) => [...r]);
}

export function matVec(A: Mat, x: Vec): Vec {
  return A.map((row) => row.reduce((s, v, j) => s + v * (x[j] ?? 0), 0));
}

export function dot(a: Vec, b: Vec): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

export function matMul(A: Mat, B: Mat): Mat {
  const n = A.length;
  const k = B.length;
  const m = B[0]?.length ?? 0;
  const C = zeros(n, m);
  for (let i = 0; i < n; i++) {
    const Ai = A[i] as number[];
    const Ci = C[i] as number[];
    for (let p = 0; p < k; p++) {
      const a = Ai[p] ?? 0;
      if (a === 0) continue;
      const Bp = B[p] as number[];
      for (let j = 0; j < m; j++) Ci[j] = (Ci[j] ?? 0) + a * (Bp[j] ?? 0);
    }
  }
  return C;
}

export function transpose(A: Mat): Mat {
  const n = A.length;
  const m = A[0]?.length ?? 0;
  const T = zeros(m, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < m; j++) (T[j] as number[])[i] = A[i]?.[j] ?? 0;
  return T;
}

export function add(A: Mat, B: Mat): Mat {
  return A.map((row, i) => row.map((v, j) => v + (B[i]?.[j] ?? 0)));
}

export function sub(A: Mat, B: Mat): Mat {
  return A.map((row, i) => row.map((v, j) => v - (B[i]?.[j] ?? 0)));
}

export function scale(A: Mat, s: number): Mat {
  return A.map((row) => row.map((v) => v * s));
}

export function outer(a: Vec, b: Vec): Mat {
  return a.map((x) => b.map((y) => x * y));
}

/** Force exact symmetry after floating-point updates. */
export function symmetrize(A: Mat): Mat {
  const n = A.length;
  const S = zeros(n, n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) (S[i] as number[])[j] = ((A[i]?.[j] ?? 0) + (A[j]?.[i] ?? 0)) / 2;
  return S;
}

/** Grow a square matrix by one row/column of zeros with `v` on the new diagonal. */
export function extend(P: Mat, v: number): Mat {
  const n = P.length;
  const Q = zeros(n + 1, n + 1);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) (Q[i] as number[])[j] = P[i]?.[j] ?? 0;
  (Q[n] as number[])[n] = v;
  return Q;
}

/** Solve A x = b by Gaussian elimination with partial pivoting (A small, square). */
export function solve(A: Mat, b: Vec): Vec {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i] ?? 0]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) {
      if (Math.abs(M[r]?.[c] ?? 0) > Math.abs(M[p]?.[c] ?? 0)) p = r;
    }
    const tmp = M[c] as number[];
    M[c] = M[p] as number[];
    M[p] = tmp;
    const pivot = M[c]?.[c] ?? 0;
    if (Math.abs(pivot) < 1e-14) throw new Error('singular matrix');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = (M[r]?.[c] ?? 0) / pivot;
      if (f === 0) continue;
      const Mr = M[r] as number[];
      const Mc = M[c] as number[];
      for (let k = c; k <= n; k++) Mr[k] = (Mr[k] ?? 0) - f * (Mc[k] ?? 0);
    }
  }
  return M.map((row, i) => (row[n] ?? 0) / (row[i] ?? 1));
}

/** Cholesky test: true when A is symmetric positive semi-definite (within tol). */
export function isPsd(A: Mat, tol = 1e-10): boolean {
  const n = A.length;
  const L = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i]?.[j] ?? 0;
      for (let k = 0; k < j; k++) s -= (L[i]?.[k] ?? 0) * (L[j]?.[k] ?? 0);
      if (i === j) {
        if (s < -tol) return false;
        (L[i] as number[])[j] = Math.sqrt(Math.max(s, 0));
      } else {
        const d = L[j]?.[j] ?? 0;
        (L[i] as number[])[j] = d > 0 ? s / d : 0;
      }
    }
  }
  return true;
}

/** Linear regression slope of y on x (least squares). */
export function slope(x: readonly number[], y: readonly number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return Number.NaN;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i] ?? 0;
    sy += y[i] ?? 0;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - mx;
    sxx += dx * dx;
    sxy += dx * ((y[i] ?? 0) - my);
  }
  return sxx > 0 ? sxy / sxx : Number.NaN;
}
