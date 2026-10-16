// Linear expressions shared by modelBuilder and mathOpt.

/** Anything usable where an expression is expected. */
export type LinearExprLike = LinearExpr | number;

/** An immutable affine expression: sum(coeff * variable) + constant. */
export class LinearExpr {
  protected constructor();
  static sum(items: readonly LinearExprLike[]): LinearExpr;
  static weightedSum(items: readonly LinearExprLike[], coeffs: readonly number[]): LinearExpr;
  static term(item: LinearExprLike, coeff: number): LinearExpr;
  static affine(item: LinearExprLike, coeff: number, constant: number): LinearExpr;
  static constant(value: number): LinearExpr;
  plus(other: LinearExprLike): LinearExpr;
  minus(other: LinearExprLike): LinearExpr;
  times(coeff: number): LinearExpr;
  neg(): LinearExpr;
  le(rhs: LinearExprLike): BoundedLinearExpression;
  ge(rhs: LinearExprLike): BoundedLinearExpression;
  eq(rhs: LinearExprLike): BoundedLinearExpression;
  readonly constant: number;
  terms(): Array<[VariableBase, number]>;
  toString(): string;
}

/** lowerBound <= expression <= upperBound; pass it to Model.add(). */
export class BoundedLinearExpression {
  constructor(expr: LinearExprLike, lowerBound: number, upperBound: number);
  readonly expression: LinearExpr;
  readonly lowerBound: number;
  readonly upperBound: number;
}

/** Base of each module's Variable: a variable is the expression 1 * variable. */
export class VariableBase extends LinearExpr {
  protected constructor();
}
