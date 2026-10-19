'use strict';

// Handles on the constraints of a CpModel. Both refer to their entry in the
// model's CpModelProto by index and are only valid for that model.

/**
 * Checks a name: a string of well-formed Unicode. A lone surrogate would turn
 * into invalid JSON for protobuf and fail later with a misleading error.
 */
function checkName(name, what) {
  if (typeof name !== 'string') throw new TypeError(`${what} must be a string`);
  if (!name.isWellFormed()) throw new TypeError(`${what} must be well-formed Unicode (no lone surrogates)`);
  return name;
}

/** A list given either as one Array or as separate arguments. */
function listArgs(args) {
  return args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
}

/** A constraint of a CpModel, returned by every CpModel.add*() method. */
class CpConstraint {
  constructor(model, index) {
    this._model = model;
    this.index = index;
    Object.freeze(this);
  }

  /**
   * Only enforce the constraint when every literal is true. Takes literals as
   * separate arguments or as one Array; can be called several times.
   */
  onlyEnforceIf(...literals) {
    const refs = listArgs(literals).map((literal, i) => this._model._literal(literal, `enforcement literal ${i}`));
    const proto = this._proto;
    proto.enforcementLiteral = (proto.enforcementLiteral ?? []).concat(refs);
    return this;
  }

  /** Names the constraint (shown in OR-Tools' messages). */
  withName(name) {
    checkName(name, 'withName(name): name');
    this._proto.name = name;
    return this;
  }

  get name() {
    return this._proto.name ?? '';
  }

  get _proto() {
    return this._model._proto.constraints[this.index];
  }

  toString() {
    return this.name || `constraint #${this.index}`;
  }
}

/** An interval (start + size == end), used by NoOverlap, NoOverlap2D and Cumulative. */
class IntervalVar {
  constructor(model, index, start, size, end, presence) {
    this._model = model;
    this.index = index;
    this._start = start;
    this._size = size;
    this._end = end;
    this._presence = presence;
    Object.freeze(this);
  }

  get name() {
    return this._model._proto.constraints[this.index].name ?? '';
  }
  startExpr() {
    return this._start;
  }
  sizeExpr() {
    return this._size;
  }
  endExpr() {
    return this._end;
  }
  /** The presence literal of an optional interval, or null. */
  presenceLiteral() {
    return this._presence;
  }

  toString() {
    return this.name || `interval #${this.index}`;
  }
}

module.exports = { CpConstraint, IntervalVar, listArgs, checkName };
