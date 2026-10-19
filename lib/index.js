/**
 * dsh-tool-mcsrc —— 查询 Minecraft 反编译源码的 DSH 工具。
 *
 * 为什么需要它：开发 Minecraft 模组时，"这个类在哪个包""这个方法签名是什么"
 * 每次都要手写一遍 zip 解析脚本。这个工具把最常见的三种查询做成了原语。
 *
 * 设计取舍：Node 没有内置 zip 读取，与其引依赖，不如把源码【预先解压】一次，
 * 这里只做纯文本读取 —— 没有依赖、不会因为 zip 格式变化而失效。
 *
 * 三种查询方式：
 *   · 只给 query        → 按类名找文件（列出候选路径）
 *   · query + pattern   → 在该文件里按正则过滤行（看某个 API 怎么用）
 *   · query + members   → 列出 public/protected 成员签名（看 API 长什么样）
 */
import fs from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'

const name = 'tool-mcsrc'
const inject = ['tools']

/** 默认解压位置：模组开发时反编译源码的落地目录 */
const DEFAULT_ROOT = 'D:\\mcsrc'

const Config = z.object({
  root: z.string().default(DEFAULT_ROOT).description('已解压的 Minecraft 源码根目录'),
  maxResults: z.number().default(30).description('找类时最多列出多少个候选'),
  maxLines: z.number().default(80).description('输出最多多少行'),
})

const MEMBER_RE = /^\s*(public|protected)\s[^;{]*[({;]\s*$|^\s*(public|protected)\s.*[({]\s*$/

/** 递归收集全部 .java 路径（相对 root），只在第一次查询时做一次 */
function walkJava(root, maxFiles = 200000) {
  const out = []
  const stack = ['']
  while (stack.length > 0 && out.length < maxFiles) {
    const rel = stack.pop()
    const abs = rel ? path.join(root, rel) : root
    let entries
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push(childRel)
      else if (e.name.endsWith('.java')) out.push(childRel)
    }
  }
  return out
}

function buildIndex(root) {
  const files = walkJava(root)
  const bySimpleName = new Map()
  for (const f of files) {
    const base = f.slice(f.lastIndexOf('/') + 1).replace(/\.java$/, '')
    // 嵌套类可能叫 Outer$Inner 或 Outer.Inner，两种都索引
    const simple = base.replace(/^\$+/, '')
    const key = simple.toLowerCase()
    if (!bySimpleName.has(key)) bySimpleName.set(key, [])
    bySimpleName.get(key).push(f)
    // 同时按"去掉外层类名"索引，方便只知道 Inner 名时也能找到
    if (base.includes('$')) {
      const inner = base.slice(base.lastIndexOf('$') + 1).toLowerCase()
      if (!bySimpleName.has(inner)) bySimpleName.set(inner, [])
      bySimpleName.get(inner).push(f)
    }
  }
  return { files, bySimpleName }
}

function lineNumbered(lines, startAt = 1) {
  const width = String(startAt + lines.length - 1).length
  return lines.map((l, i) => `${String(startAt + i).padStart(width)}: ${l}`).join('\n')
}

function apply(ctx, config) {
  const cfg = config ?? {}
  const root = cfg.root || DEFAULT_ROOT
  const maxResults = Number(cfg.maxResults || 30)
  const maxLines = Number(cfg.maxLines || 80)

  let index = null
  const ensureIndex = () => {
    if (index === null) index = buildIndex(root)
    return index
  }

  ctx.tools.register(defineTool({
    name: 'mcsrc',
    description: [
      'Query the decompiled Minecraft sources (already extracted on disk).',
      'Use it BEFORE writing code against an unfamiliar class, so you do not have to',
      'find out the hard way that a class was renamed or moved.',
      'query alone: find candidate class files by simple name or path fragment.',
      'query + pattern: show matching lines (regex) inside the file.',
      'query + members: list public/protected member signatures.',
    ].join(' '),
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Class simple name (e.g. LecternBlock) or a path fragment (e.g. level/block/Lectern).',
      },
      pattern: {
        type: 'string',
        description: 'Optional regex; only lines matching it are returned.',
      },
      members: {
        type: 'boolean',
        description: 'Optional; list public/protected member signatures instead of raw lines.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const query = String(args?.query ?? '').trim()
      if (!query) return { text: 'mcsrc: query 不能为空' }

      if (!fs.existsSync(root)) {
        return { text: `mcsrc: 源码目录不存在：${root}\n（先把反编译源码解压到那里，或改插件配置的 root）` }
      }

      const idx = ensureIndex()
      const q = query.toLowerCase().replace(/\.java$/, '')

      // ── 1) 找文件 ──
      let candidates
      if (query.includes('/')) {
        candidates = idx.files.filter((f) => f.toLowerCase().includes(q)).slice(0, maxResults)
      } else {
        candidates = (idx.bySimpleName.get(q.replace(/.*[.$]/, '')) ?? [])
          .concat(idx.files.filter((f) => f.toLowerCase().endsWith('/' + q + '.java')))
        candidates = [...new Set(candidates)].slice(0, maxResults)
        if (candidates.length === 0) {
          // 退一步：当成路径片段搜
          candidates = idx.files.filter((f) => f.toLowerCase().includes(q)).slice(0, maxResults)
        }
      }

      if (candidates.length === 0) {
        return { text: `mcsrc: 在 ${root} 里找不到与 "${query}" 匹配的类。\n共索引 ${idx.files.length} 个 .java 文件。` }
      }

      // 只有 query：列候选
      if (!args?.pattern && !args?.members) {
        const head = `mcsrc: 匹配 "${query}" 的候选（共索引 ${idx.files.length} 个文件，显示前 ${candidates.length} 个）`
        return { text: [head, ...candidates.map((c) => '  ' + c)].join('\n') }
      }

      // ── 2) 读第一个候选，按 pattern / members 输出 ──
      const rel = candidates[0]
      const abs = path.join(root, rel)
      let content
      try {
        content = fs.readFileSync(abs, 'utf8')
      } catch (e) {
        return { text: `mcsrc: 读取失败 ${rel} —— ${e?.message ?? e}` }
      }
      const all = content.split(/\r?\n/)

      const parts = [`mcsrc: ${rel}（共 ${all.length} 行）`]
      if (candidates.length > 1) {
        parts.push(`（另有 ${candidates.length - 1} 个候选：${candidates.slice(1, 6).join(' , ')}）`)
      }

      if (args?.pattern) {
        let re
        try {
          re = new RegExp(String(args.pattern), 'i')
        } catch (e) {
          return { text: `mcsrc: 正则不合法 —— ${e?.message ?? e}` }
        }
        const hits = []
        for (let i = 0; i < all.length && hits.length < maxLines; i++) {
          if (re.test(all[i])) hits.push({ n: i + 1, t: all[i] })
        }
        if (hits.length === 0) {
          parts.push(`没有匹配 /${args.pattern}/ 的行`)
        } else {
          parts.push(`匹配 /${args.pattern}/ 的 ${hits.length} 行：`)
          const width = String(hits[hits.length - 1].n).length
          parts.push(hits.map((h) => `${String(h.n).padStart(width)}: ${h.t}`).join('\n'))
        }
        return { text: parts.join('\n') }
      }

      // members 模式
      //
      // ⚠️ 不能只认 `public|protected`：接口方法不写访问修饰符（`void write(...)`），
      //    record 的组件访问器也是。第一版就因为这个把 IPayloadContext 报成"0 条成员"。
      //    所以补一条"长得像方法/字段声明"的启发式，并排除控制流关键字。
      const CONTROL_RE = /^\s*(if|for|while|switch|catch|return|new|throw|assert|else|do)\b/
      const looksLikeMember = (line) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return false
        if (/^\s*(public|protected|default)\s/.test(line)) return true
        if (CONTROL_RE.test(line)) return false
        const isMethod = /^\s*(?:<[^>]+>\s*)?[\w$.<>[\],? ]+\s+[\w$]+\s*\(/.test(line)
        const isField = /^\s*[\w$.<>[\],? ]+\s+[\w$]+\s*;\s*$/.test(line)
        return isMethod || isField
      }

      const members = []
      for (let i = 0; i < all.length && members.length < maxLines; i++) {
        const line = all[i]
        if (looksLikeMember(line)
            && !/^\s*(public|protected|private)?\s*(class|interface|enum|record|@)/.test(line)) {
          members.push({ n: i + 1, t: line.trim() })
        }
      }
      parts.push(`成员 ${members.length} 条：`)
      const width = String(members.at(-1)?.n ?? 1).length
      parts.push(members.map((m) => `${String(m.n).padStart(width)}: ${m.t}`).join('\n'))
      return { text: parts.join('\n') }
    },
  }))

  ctx.logger?.info?.(`[mcsrc] ready, root=${root}`)
  void lineNumbered
  void MEMBER_RE
}

export { Config, apply, inject, name }
