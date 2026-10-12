/**
 * Worker threads for the work that reads a book's file.
 *
 * Until the threads are started, a task runs where it is called: that is what a
 * test, a script and the importer get, and it is the same code. The server starts
 * them, and from then on a task runs on a thread of its own and the main thread
 * stays free to answer requests.
 *
 * How many tasks run at once is decided by whoever calls: the job worker runs as
 * many jobs as the server's task pool allows, and each job waits for its task. The
 * pool here only has to be large enough not to be the limit, and lets a thread go
 * when it has had nothing to do for a while.
 */

import { availableParallelism } from 'node:os'
import { Piscina } from 'piscina'

import * as tasks from './tasks.js'

type Tasks = typeof tasks
export type TaskName = keyof Tasks

/** How long a thread with nothing to do is kept. */
const IDLE_MS = 60_000

let pool: Piscina | null = null

/** The most threads this machine is asked for: every core but the one that serves. */
export function defaultThreadLimit(): number {
  return Math.max(1, availableParallelism() - 1)
}

/**
 * How a thread is told to read this project's source.
 *
 * Built, the worker is JavaScript and needs nothing. Run from source, it is
 * TypeScript: a thread inherits the loader when the process was started with one,
 * and is given it when the process was not - a test runner transforms the main
 * thread's code itself, and its threads would otherwise meet a `.ts` file bare.
 */
function workerSettings(): { filename: string; execArgv?: string[] } {
  const fromSource = import.meta.url.endsWith('.ts')
  const filename = new URL(fromSource ? './tasks.ts' : './tasks.js', import.meta.url).href
  if (!fromSource || process.execArgv.some((argument) => argument.includes('tsx'))) return { filename }
  return { filename, execArgv: ['--import', 'tsx'] }
}

/** Start the threads. Says how many there may be at most. */
export function startThreads(options: { maxThreads?: number } = {}): number {
  const maxThreads = Math.max(1, options.maxThreads ?? defaultThreadLimit())
  if (pool !== null) return maxThreads

  pool = new Piscina({
    ...workerSettings(),
    minThreads: 0,
    maxThreads,
    idleTimeout: IDLE_MS,
  })
  return maxThreads
}

/** Stop the threads, once what they are doing is done. Tasks run in place again. */
export async function stopThreads(): Promise<void> {
  const stopping = pool
  pool = null
  await stopping?.close()
}

/** Whether tasks are being run on threads. */
export function threadsStarted(): boolean {
  return pool !== null
}

/** Run a task: on a thread when there are threads, and in place when there are not. */
export async function onThread<Name extends TaskName>(
  name: Name,
  input: Parameters<Tasks[Name]>[0],
): Promise<Awaited<ReturnType<Tasks[Name]>>> {
  type Result = Awaited<ReturnType<Tasks[Name]>>
  if (pool === null) {
    const task = tasks[name] as (input: Parameters<Tasks[Name]>[0]) => Promise<Result>
    return task(input)
  }
  return (await pool.run(input, { name })) as Result
}
