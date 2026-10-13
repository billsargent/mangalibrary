/**
 * Two things every query needs once a library is large, done in one place rather
 * than at each of the queries.
 */

import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  type BinaryOperationNode,
  type KyselyPlugin,
  OperationNodeTransformer,
  OperatorNode,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  PrimitiveValueListNode,
  type QueryResult,
  RawNode,
  type RootOperationNode,
  type UnknownRow,
  ValueListNode,
  ValueNode,
} from 'kysely'

/**
 * How many values an `in (...)` list may hold before it is passed another way.
 *
 * SQLite refuses a statement with more than 32,766 bound values, and a list of ids
 * binds one each: "every book of this library" meets that at a size a real library
 * reaches. Well below the limit, because a statement can hold several lists.
 */
export const LONG_LIST = 500

/**
 * Passes a long `in (...)` list as one value.
 *
 * The list is bound as a single JSON array and read back with `json_each`, which
 * SQLite treats as a table. The statement means the same and has one bound value
 * however long the list is. Short lists are left alone: they are the common case
 * and are planned well as they are.
 */
class LongListTransformer extends OperationNodeTransformer {
  protected override transformBinaryOperation(node: BinaryOperationNode): BinaryOperationNode {
    const transformed = super.transformBinaryOperation(node)
    const operator = transformed.operator
    if (!OperatorNode.is(operator) || (operator.operator !== 'in' && operator.operator !== 'not in')) {
      return transformed
    }

    const list = transformed.rightOperand
    let values: unknown[] | null = null
    if (PrimitiveValueListNode.is(list)) values = [...list.values]
    else if (ValueListNode.is(list) && list.values.every((value) => ValueNode.is(value))) {
      values = list.values.map((value) => (value as ValueNode).value)
    }
    if (values === null || values.length <= LONG_LIST) return transformed
    // Only what JSON carries unchanged: an id is text, and a count is a number.
    if (!values.every((value) => typeof value === 'string' || typeof value === 'number')) return transformed

    return {
      ...transformed,
      rightOperand: RawNode.create(['(select value from json_each(', '))'], [ValueNode.create(JSON.stringify(values))]),
    }
  }
}

export class LongListPlugin implements KyselyPlugin {
  readonly #transformer = new LongListTransformer()

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.#transformer.transformNode(args.node)
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return args.result
  }
}

/** How long queries may run back to back before everything else gets a turn. */
const TURN_AFTER_MS = 10

/**
 * Lets the rest of the server run during a long run of queries.
 *
 * The database driver answers at once, without waiting, so a loop of queries - a
 * scan writing a large library is forty thousand of them - never comes up for
 * air: no request is read, no response is sent, no connection is kept alive until
 * the loop ends. Measured on a 40,000-book library, that was 87 seconds of a
 * server that answered nobody.
 *
 * After a few milliseconds of queries this hands the turn over once, which costs
 * almost nothing and bounds how long anything else waits.
 */
export class TakeTurnsPlugin implements KyselyPlugin {
  #lastTurn = performance.now()

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return args.node
  }

  async transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    if (performance.now() - this.#lastTurn >= TURN_AFTER_MS) {
      await nextTurn()
      this.#lastTurn = performance.now()
    }
    return args.result
  }
}
