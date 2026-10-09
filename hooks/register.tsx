import type { Register } from 'claude-code'

// ---------- 参数 ----------
// 缓存有效期 1 小时。闲置满 FIRE_MIN 分钟就补发一次保温，留出余量防止卡在 60 分钟边缘。
const SHOW_MIN = 0
const WARN_MIN = 45
const FIRE_MIN = 50
const MAX_HOURS = 24 // 硬上限：Claude Code 每日清理缓存的时刻未核实，任何设置都不得超过 24 小时
const COMPACT_AT = 295000 // 读不到引擎阈值时的后备值：窗口 327680 时实测的自动压缩触发长度（中位约 299K）
const PROMPT = '【保温】这是缓存保温请求，不要调用任何工具，不要继续之前的任务，只回复两个字：保温。'
const PANE = 'keepwarm-chart'

// 橙色主色调
const C_MAIN = '#EA7A12'
const C_DARK = '#9A3412'
const C_LIGHT = '#FDBA74'
const C_GOLD = '#D97706'
const C_RED = '#DC2626'
const C_TEXT = '#8a8a8a'
const C_GRID = 'rgba(128,128,128,0.25)'

// 只读本会话记录里的 usage、时间戳、模型和压缩元数据，不读对话内容
const PY = [
  'import sys,json,glob,os',
  "fs=glob.glob(os.path.join(os.path.expanduser('~'),'.claude','projects','*',sys.argv[1]+'.jsonl'))",
  'rows={};comp=[]',
  'for f in fs:',
  "  for line in open(f,encoding='utf-8',errors='replace'):",
  "    if '\"usage\"' not in line and 'compact_boundary' not in line: continue",
  '    try: d=json.loads(line)',
  '    except Exception: continue',
  "    if d.get('type')=='assistant':",
  "      m=d.get('message') or {};u=m.get('usage')",
  "      if not u or not m.get('id') or m.get('model')=='<synthetic>': continue",
  "      rows.setdefault(m['id'],{'t':d.get('timestamp'),'m':m.get('model'),'i':u.get('input_tokens',0),'cw':u.get('cache_creation_input_tokens',0),'cr':u.get('cache_read_input_tokens',0),'o':u.get('output_tokens',0)})",
  "    elif d.get('subtype')=='compact_boundary':",
  "      cm=d.get('compactMetadata') or {}",
  "      comp.append({'t':d.get('timestamp'),'trig':cm.get('trigger'),'pre':cm.get('preTokens'),'post':cm.get('postTokens')})",
  "print(json.dumps({'r':list(rows.values()),'c':comp}))",
].join('\n')

// 长期汇总：扫描全部项目的会话记录，同样只取 usage、时间戳、模型和压缩元数据；逐文件缓存到 ~/.claude/keepwarm-cache
// 输入（标准输入）：{ edges: 分格边界毫秒数组, kw: 保温时刻 }；输出每格的请求数、费用拆分、缓存写入拆分、上下文与压缩次数
const AGG_PY = String.raw`import sys,json,glob,os,bisect
from datetime import datetime
P=json.loads(sys.stdin.read())
E=P['edges'];KW=sorted(P.get('kw',[]));T0=E[0];T1=E[-1]
H=os.path.expanduser('~');R=os.path.join(H,'.claude','projects')
CD=os.path.join(H,'.claude','keepwarm-cache');CF=os.path.join(CD,'rows.json')
try: C=json.load(open(CF,encoding='utf-8'))
except Exception: C={}
def ms(s):
  try: return int(datetime.fromisoformat(s.replace('Z','+00:00')).timestamp()*1000)
  except Exception: return None
def parse(f):
  rows={};comp=[]
  for line in open(f,encoding='utf-8',errors='replace'):
    if '"usage"' not in line and 'compact_boundary' not in line: continue
    try: d=json.loads(line)
    except Exception: continue
    if d.get('type')=='assistant':
      m=d.get('message') or {};u=m.get('usage')
      if not u or not m.get('id') or m.get('model')=='<synthetic>': continue
      t=ms(d.get('timestamp') or '')
      if t is None: continue
      rows.setdefault(m['id'],[t,m.get('model') or '',u.get('input_tokens',0) or 0,u.get('cache_creation_input_tokens',0) or 0,u.get('cache_read_input_tokens',0) or 0,u.get('output_tokens',0) or 0])
    elif d.get('subtype')=='compact_boundary':
      cm=d.get('compactMetadata') or {};t=ms(d.get('timestamp') or '')
      if t is not None: comp.append([t,cm.get('trigger'),cm.get('preTokens') or 0])
  return [[k]+v for k,v in rows.items()],comp
fs=glob.glob(os.path.join(R,'*','*.jsonl'))+glob.glob(os.path.join(R,'*','*','subagents','*.jsonl'))
st=[(f,os.stat(f)) for f in fs]
st=[x for x in st if x[1].st_mtime*1000>=T0-86400000]
st.sort(key=lambda x:x[1].st_mtime)
NC={};seen=set();seqs=[]
for f,s in st:
  key=f'{s.st_mtime_ns}:{s.st_size}'
  c=C.get(f)
  if not c or c['k']!=key:
    r,cp=parse(f);c={'k':key,'r':r,'c':cp}
  NC[f]=c
  rs=[]
  for x in c['r']:
    if x[0] in seen: continue
    seen.add(x[0]);rs.append(x[1:])
  rs.sort(key=lambda x:x[0])
  seqs.append((rs,[x for x in c['c']],'subagents' in f))
try:
  os.makedirs(CD,exist_ok=True);json.dump(NC,open(CF+'.tmp','w',encoding='utf-8'));os.replace(CF+'.tmp',CF)
except Exception: pass
def price(m):
  m=m.lower()
  if 'sonnet' in m: return 2,10
  if 'haiku' in m: return 1,5
  return 4,20
nb=len(E)-1
B=[{'n':0,'base':0,'rebuild':0,'kw':0,'cold':0,'avoided':0,'coldN':0,'kwN':0,'i':0,'cw':0,'cr':0,'o':0,'ctx':[],'cwHit':0,'cwIdle':0,'cwRe':0,'cwKw':0,'compA':0,'compM':0,'pre':0,'ses':set()} for _ in range(nb)]
def bin_of(t):
  if t<T0 or t>=T1: return -1
  return bisect.bisect_right(E,t)-1
def is_kw(t):
  j=bisect.bisect_left(KW,t-180000)
  return j<len(KW) and KW[j]<=t+2000
for si,(rs,comps,sub) in enumerate(seqs):
  ct=sorted(c[0] for c in comps)
  for c in comps:
    b=bin_of(c[0])
    if b>=0:
      if c[1]=='auto': B[b]['compA']+=1
      else: B[b]['compM']+=1
      B[b]['pre']=max(B[b]['pre'],c[2])
  prev=0;lastReal=None;chain=0;chainInp=4
  for t,m,i,cw,cr,o in rs:
    ctx=i+cw+cr
    if ctx<=0: prev=t;continue
    inp,out=price(m)
    cost=(i*inp+cr*0.05*inp+cw*2*inp+o*out)/1e6
    gap=(t-prev)/60000 if prev else 0
    miss=cw>0.5*ctx and ctx>30000
    extra=cw*1.95*inp/1e6 if miss else 0
    j=bisect.bisect_right(ct,prev);after=j<len(ct) and ct[j]<=t
    if is_kw(t): kind='kw'
    elif not miss: kind='hit'
    elif after: kind='compact'
    elif gap>=60 and not sub: kind='idle'
    else: kind='other'
    b=bin_of(t);q=B[b] if b>=0 else None
    if kind=='kw':
      if q: q['kw']+=cost;q['kwN']+=1;q['cwKw']+=cw
      chain=ctx;chainInp=inp
    else:
      if chain>0 and lastReal is not None and t-lastReal>=3600000 and gap<60 and q: q['avoided']+=chain*1.95*chainInp/1e6
      chain=0;lastReal=t
      if q:
        if kind=='idle': q['cold']+=extra;q['coldN']+=1;q['cwIdle']+=cw
        elif kind=='hit': q['cwHit']+=cw
        else: q['rebuild']+=extra;q['cwRe']+=cw
        q['base']+=cost-extra
    if q:
      q['n']+=1;q['i']+=i;q['cw']+=cw;q['cr']+=cr;q['o']+=o;q['ses'].add(si)
      if not sub: q['ctx'].append(ctx)
    prev=t
out=[]
for q in B:
  c=sorted(q.pop('ctx'));q['ses']=len(q['ses'])
  q['ctxMax']=c[-1] if c else 0;q['ctxMed']=c[len(c)//2] if c else 0
  for k in ('base','rebuild','kw','cold','avoided'): q[k]=round(q[k],4)
  out.append(q)
print(json.dumps({'b':out,'files':len(st)}))`

// ---------- 模块状态 ----------
let lastAt: number | null = null // 最近一次任何请求（含保温）
let lastReal: number | null = null // 最近一次你本人的请求，保温时长从这里起算
let hours = 0 // 接续保温的小时数，0 为关闭
let busy = false
let sent = 0
let kwTimes: number[] = [] // 本次加载以来发出的保温请求时刻
let view = 'line' // line | cost | ctx
let data: any = null // { reqs, comps }
let loadError = ''
let compactAt = COMPACT_AT // 打开图表时从引擎读取本会话的自动压缩阈值
let paneOpen = false
let span = 'ses' // ses 本会话 | hour | day | week | month
let agg: any = null // { b: 每格汇总, edges, unit }
let aggAt = 0
let aggBusy = false
let aggError = ''
let cumBy: Record<string, boolean> = { hour: true, d7: true } // 每档默认：短范围看累计，长范围看每段

// ---------- 纯函数 ----------
const p2 = (n: number) => String(n).padStart(2, '0')
const hm = (t: number) => {
  const d = new Date(t)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}`
}
const md = (t: number) => {
  const d = new Date(t)
  return `${p2(d.getMonth() + 1)}/${p2(d.getDate())}`
}
const kfmt = (n: number) => (n === 0 ? '0' : `${Math.round(n / 1000)}K`)
const usd = (v: number) => `${v < 0 ? '−' : ''}$${Math.abs(v) < 10 ? Math.abs(v).toFixed(2) : Math.abs(v).toFixed(1)}`
const dur = (min: number) => (min >= 2880 ? `${Math.round(min / 1440)} 天` : min >= 120 ? `${Math.round(min / 60)} 小时` : `${Math.round(min)} 分`)
const HOUR = 3600000
const KIND_NAME: Record<string, string> = { hit: '命中', kw: '保温', idle: '冷读取', compact: '压缩后重建', other: '重写' }

function priceOf(model: string) {
  const m = (model || '').toLowerCase()
  if (m.includes('sonnet')) return { inp: 2, out: 10 }
  if (m.includes('haiku')) return { inp: 1, out: 5 }
  return { inp: 4, out: 20 } // opus 及未识别：按 Opus 5.5 列表价
}

// 每次请求分类：hit 命中；kw 保温；idle 闲置超过 1 小时后的冷读取（保温可避免）；
// compact 压缩后重建、other 其他整段重写（如换模型），这两类保温无法避免
function prep(raw: any) {
  const comps = (raw.c || []).map((x: any) => ({ t: Date.parse(x.t), trig: x.trig, pre: x.pre || 0 })).filter((x: any) => Number.isFinite(x.t))
  const reqs = (raw.r || [])
    .map((x: any) => ({ t: Date.parse(x.t), m: x.m || '', i: x.i, cw: x.cw, cr: x.cr, o: x.o }))
    .filter((x: any) => Number.isFinite(x.t) && x.i + x.cw + x.cr > 0)
    .sort((a: any, b: any) => a.t - b.t)
  let prev = 0
  for (const q of reqs) {
    q.ctx = q.i + q.cw + q.cr
    q.inp = priceOf(q.m).inp
    q.cost = (q.i * q.inp + q.cr * 0.05 * q.inp + q.cw * 2 * q.inp + q.o * priceOf(q.m).out) / 1e6
    q.gap = prev ? (q.t - prev) / 60000 : 0
    const isMiss = q.cw > 0.5 * q.ctx && q.ctx > 30000
    q.extra = isMiss ? (q.cw * 1.95 * q.inp) / 1e6 : 0
    const afterCompact = comps.some((c: any) => c.t > prev && c.t <= q.t)
    if (kwTimes.some(k => q.t >= k - 2000 && q.t <= k + 180000)) q.kind = 'kw'
    else if (!isMiss) q.kind = 'hit'
    else if (afterCompact) q.kind = 'compact'
    else if (q.gap >= 60) q.kind = 'idle'
    else q.kind = 'other'
    prev = q.t
  }
  return { reqs, comps }
}

// 费用账本：逐次累计正常费用、无法避免的重建、保温花费、冷读取多付，以及保温避免的冷读取
function ledger(rs: any[]) {
  let base = 0
  let rebuild = 0
  let kw = 0
  let cold = 0
  let avoided = 0
  let coldN = 0
  let kwN = 0
  let lastRealT: number | null = null
  let chainCtx = 0
  let chainInp = 4
  const rows = rs.map((q: any) => {
    if (q.kind === 'kw') {
      kw += q.cost
      kwN += 1
      chainCtx = q.ctx
      chainInp = q.inp
    } else {
      // 一串保温之后的第一句真实请求：若离上一句真实请求已满 1 小时、而缓存仍热，记为避免了一次冷读取
      if (chainCtx > 0 && lastRealT !== null && q.t - lastRealT >= HOUR && q.gap < 60) avoided += (chainCtx * 1.95 * chainInp) / 1e6
      chainCtx = 0
      lastRealT = q.t
      if (q.kind === 'idle') {
        cold += q.extra
        coldN += 1
      } else rebuild += q.extra
      base += q.cost - q.extra
    }
    return { t: q.t, s1: base, s2: base + rebuild, s3: base + rebuild + kw, s4: base + rebuild + kw + cold, cf: base + rebuild + cold + avoided }
  })
  return { rows, base, rebuild, kw, cold, avoided, coldN, kwN }
}

function down(a: any[], n: number): any[] {
  if (a.length <= n) return a
  const step = a.length / n
  const out: any[] = []
  for (let i = 0; i < n; i++) out.push(a[Math.floor(i * step)])
  out.push(a[a.length - 1])
  return out
}

// 纵轴刻度取 1、2、2.5、5 乘 10 的整数次幂，至多 n 格
function nice(v: number, n = 4) {
  const raw = Math.max(v, 1e-9) / n
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  let step = 10 * mag
  for (const m of [1, 2, 2.5, 5]) {
    if (m * mag >= raw) {
      step = m * mag
      break
    }
  }
  return { max: Math.ceil(v / step - 1e-9) * step, step }
}

// 界面文字用中性色并随深浅主题切换；橙色只用于数据
const FONT = "system-ui,-apple-system,'Segoe UI','Microsoft YaHei','PingFang SC',sans-serif"
const STYLE =
  '<style>.p{fill:#1f2328}.s{fill:#656d76}.g{stroke:rgba(128,128,128,.2)}.ax{stroke:rgba(128,128,128,.55)}' +
  '.bg{fill:rgba(128,128,128,.07)}.tr{fill:rgba(128,128,128,.2)}.hl{fill:#9A3412}.ring{stroke:#f6f6f6}' +
  '@media (prefers-color-scheme:dark){.p{fill:#e6edf3}.s{fill:#9da5ae}.hl{fill:#FDBA74}.ring{stroke:#2a2a2a}}</style>'
const DEFS =
  '<defs>' +
  `<linearGradient id="warm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C_MAIN}" stop-opacity=".45"/><stop offset="1" stop-color="${C_MAIN}" stop-opacity=".05"/></linearGradient>` +
  `<linearGradient id="soft" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C_MAIN}" stop-opacity=".18"/><stop offset="1" stop-color="${C_MAIN}" stop-opacity=".03"/></linearGradient>` +
  '<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="rgba(128,128,128,.06)"/><line x1="0" y1="0" x2="0" y2="6" stroke="rgba(128,128,128,.32)" stroke-width="1.6"/></pattern>' +
  '</defs>'

type G = { w: number; h: number; x0: number; x1: number; y0: number; y1: number }

// 标记尺寸取画布两倍：面板按标记宽度铺满所在栏，高度按比例，放大面板时图随之放大
function doc(w: number, h: number, inner: string, card = true) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w * 2}" height="${h * 2}" font-family="${FONT}" font-size="12">` +
    STYLE +
    DEFS +
    (card ? `<rect x="0" y="0" width="${w}" height="${h}" rx="12" class="bg"/>` : '') +
    inner +
    '</svg>'
  )
}

function head(title: string, sub: string) {
  return `<text x="16" y="27" class="p" font-size="15" font-weight="600">${title}</text><text x="16" y="45" class="s">${sub}</text>`
}

function yAxis(g: G, max: number, step: number, fmt: (v: number) => string) {
  let s = ''
  for (let v = 0; v <= max + 1e-9; v += step) {
    const y = g.y1 - (v / max) * (g.y1 - g.y0)
    s += `<line x1="${g.x0}" y1="${y}" x2="${g.x1}" y2="${y}" class="${v === 0 ? 'ax' : 'g'}"/>`
    s += `<text x="${g.x0 - 6}" y="${y + 4}" text-anchor="end" class="s" font-size="11">${fmt(v)}</text>`
  }
  return s
}

function hline(g: G, y: number, color: string, label: string, below = false) {
  return (
    `<line x1="${g.x0}" y1="${y}" x2="${g.x1}" y2="${y}" stroke="${color}" stroke-width="1.2" stroke-dasharray="5 4"/>` +
    `<text x="${g.x0 + 4}" y="${below ? y + 14 : y - 5}" fill="${color}" font-size="11" font-weight="600">${label}</text>`
  )
}

// 实时间轴：刻度按本地时间对齐
function timeAxis(g: G, t0: number, t1: number) {
  const span = t1 - t0
  let step = 24 * HOUR
  for (const c of [30 * 60000, HOUR, 2 * HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR]) {
    if (span / c <= 8) {
      step = c
      break
    }
  }
  const o = new Date(t0).getTimezoneOffset() * 60000
  let s = ''
  for (let t = Math.ceil((t0 - o) / step) * step + o; t <= t1; t += step) {
    const x = g.x0 + ((t - t0) / span) * (g.x1 - g.x0)
    s += `<line x1="${x}" y1="${g.y1}" x2="${x}" y2="${g.y1 + 4}" class="ax"/>`
    s += `<text x="${x}" y="${g.y1 + 17}" text-anchor="middle" class="s" font-size="11">${hm(t)}</text>`
  }
  return s
}

// 压缩空闲：超过 30 分钟的空闲一律按 30 分钟宽度画；超过 60 分钟的记为断点
function pack(rs: any[], g: G) {
  const CAP = 30 * 60000
  const pos: number[] = []
  const breaks: { i: number; gap: number }[] = []
  let acc = 0
  for (let i = 0; i < rs.length; i++) {
    if (i > 0) {
      const d = rs[i].t - rs[i - 1].t
      acc += Math.min(d, CAP)
      if (d > HOUR) breaks.push({ i, gap: d / 60000 })
    }
    pos.push(acc)
  }
  const end = Math.max(acc, 1)
  const xs = pos.map(p => g.x0 + (p / end) * (g.x1 - g.x0))
  return { xs, breaks }
}

// 压缩轴的刻度：每段活动的起点优先，其次每小时第一次请求；标签相距不足 46 就跳过
function packAxis(g: G, rs: any[], xs: number[], breaks: { i: number }[]) {
  const cand: { x: number; t: number; pri: number }[] = [{ x: xs[0], t: rs[0].t, pri: 0 }]
  for (const b of breaks) cand.push({ x: xs[b.i], t: rs[b.i].t, pri: 1 })
  cand.push({ x: xs[xs.length - 1], t: rs[rs.length - 1].t, pri: 1 })
  let lastHour = Math.floor(rs[0].t / HOUR)
  for (let i = 1; i < rs.length; i++) {
    const h = Math.floor(rs[i].t / HOUR)
    if (h !== lastHour) cand.push({ x: xs[i], t: rs[i].t, pri: 2 })
    lastHour = h
  }
  cand.sort((a, b) => a.pri - b.pri || a.x - b.x)
  const kept: { x: number; t: number }[] = []
  for (const c of cand) if (kept.every(k => Math.abs(k.x - c.x) >= 46)) kept.push(c)
  kept.sort((a, b) => a.x - b.x)
  let s = ''
  let day = ''
  for (const k of kept) {
    s += `<line x1="${k.x}" y1="${g.y1}" x2="${k.x}" y2="${g.y1 + 4}" class="ax"/>`
    s += `<text x="${k.x}" y="${g.y1 + 17}" text-anchor="middle" class="s" font-size="11">${hm(k.t)}</text>`
    if (md(k.t) !== day) {
      day = md(k.t)
      s += `<text x="${k.x}" y="${g.y1 + 31}" text-anchor="middle" class="s" font-size="10.5" font-weight="600">${day}</text>`
    }
  }
  return s
}

function breakMarks(g: G, xs: number[], breaks: { i: number; gap: number }[]) {
  let s = ''
  let last = -100
  for (const b of breaks) {
    const x = (xs[b.i - 1] + xs[b.i]) / 2
    s += `<line x1="${x}" y1="${g.y0}" x2="${x}" y2="${g.y1}" class="g" stroke-dasharray="2 3"/>`
    if (x - last > 56) {
      s += `<text x="${x}" y="${g.y0 - 6}" text-anchor="middle" class="s" font-size="10.5">闲 ${dur(b.gap)}</text>`
      last = x
    }
  }
  return s
}

// 文字宽度粗估：中日韩字符按字号计，其余按 0.56 倍
function textW(t: string, size: number) {
  let w = 0
  for (const ch of t) w += ch.charCodeAt(0) > 255 ? size : size * 0.56
  return w
}

const dia = (x: number, y: number, r: number, fill: string, stroke: string) =>
  `<path d="M${x} ${y - r}L${x + r} ${y}L${x} ${y + r}L${x - r} ${y}Z" fill="${fill}" stroke="${stroke}" stroke-width="1.4"/>`

// 图例符号：area 渐变面积、hatch 斜纹、band 实心色块、line 实线、dash 虚线、dot 圆点、dia 菱形、odia 空心菱形、tri 三角
function swatch(kind: string, color: string, x: number, y: number) {
  if (kind === 'area') return `<rect x="${x}" y="${y - 9}" width="12" height="10" rx="2" fill="url(#warm)"/><line x1="${x}" y1="${y - 9}" x2="${x + 12}" y2="${y - 9}" stroke="${color}" stroke-width="1.6"/>`
  if (kind === 'hatch') return `<rect x="${x}" y="${y - 9}" width="12" height="10" rx="2" fill="url(#hatch)"/>`
  if (kind === 'band') return `<rect x="${x}" y="${y - 9}" width="12" height="10" rx="2" fill="${color}"/>`
  if (kind === 'dot') return `<circle cx="${x + 6}" cy="${y - 4}" r="3.6" fill="${color}"/>`
  if (kind === 'dia') return dia(x + 6, y - 4, 4.6, color, 'none')
  if (kind === 'odia') return dia(x + 6, y - 4, 4.2, 'none', color)
  if (kind === 'tri') return `<path d="M${x + 1} ${y - 9}H${x + 11}L${x + 6} ${y}Z" fill="${color}"/>`
  return `<line x1="${x}" y1="${y - 4}" x2="${x + 12}" y2="${y - 4}" stroke="${color}" stroke-width="2"${kind === 'dash' ? ' stroke-dasharray="3 2"' : ''}/>`
}

function legend(h: number, items: string[][]) {
  let s = ''
  let x = 16
  const y = h - 14
  for (const [kind, color, label] of items) {
    s += swatch(kind, color, x, y)
    s += `<text x="${x + 17}" y="${y}" class="s" font-size="11">${label}</text>`
    x += 17 + textW(label, 11) + 16
  }
  return s
}

// 右侧直接标注：按 y 排序后错开，避免文字相叠
function endLabels(g: G, items: { y: number; text: string; color: string }[]) {
  const sorted = [...items].sort((a, b) => a.y - b.y)
  let last = -100
  let s = ''
  for (const it of sorted) {
    const y = Math.max(it.y, last + 15)
    last = y
    const paint = it.color === C_DARK ? 'class="hl"' : `fill="${it.color}"`
    s += `<text x="${g.x1 + 8}" y="${y + 4}" ${paint} font-size="11.5" font-weight="600">${it.text}</text>`
  }
  return s
}

// 图一：缓存时间线（最近 3 小时到未来 1 小时）。面积是缓存里存着的上下文：缓存有效时为橙色渐变，过期后为斜纹
function svgLine(d: any, now: number) {
  const g: G = { w: 480, h: 340, x0: 46, x1: 464, y0: 70, y1: 262 }
  const t0 = now - 3 * HOUR
  const t1 = now + HOUR
  const sx = (t: number) => g.x0 + ((Math.min(Math.max(t, t0), t1) - t0) / (t1 - t0)) * (g.x1 - g.x0)
  const rs = d.reqs
  let first = rs.findIndex((q: any) => q.t >= t0)
  if (first < 0) first = rs.length
  const from = Math.max(0, first - 1)
  const vis = rs.slice(from)
  const top = vis.reduce((m: number, q: any) => Math.max(m, q.ctx), 0)
  const { max, step } = nice(Math.max(top, compactAt) * 1.06)
  const sy = (v: number) => g.y1 - (v / max) * (g.y1 - g.y0)
  let s = head('缓存时间线', '面积高度为缓存里的上下文；橙色为缓存有效，斜纹为已过期') + yAxis(g, max, step, kfmt) + timeAxis(g, t0, t1)

  // 把每次请求到下一次请求之间切成“有效”和“过期”两段
  const pieces: { a: number; b: number; ctx: number; warm: boolean }[] = []
  for (let k = 0; k < vis.length; k++) {
    const q = vis[k]
    const end = k + 1 < vis.length ? vis[k + 1].t : now
    const warmEnd = Math.min(end, q.t + HOUR)
    if (warmEnd > t0 && warmEnd > q.t) pieces.push({ a: Math.max(q.t, t0), b: warmEnd, ctx: q.ctx, warm: true })
    if (end > warmEnd && end > t0) pieces.push({ a: Math.max(warmEnd, t0), b: end, ctx: q.ctx, warm: false })
  }
  // 有效段连成整片面积，避免相邻矩形之间出现细缝
  let run: typeof pieces = []
  const flush = () => {
    if (!run.length) return
    let path = `M${sx(run[0].a)} ${g.y1}`
    let edge = ''
    for (const p of run) {
      path += `L${sx(p.a)} ${sy(p.ctx)}L${sx(p.b)} ${sy(p.ctx)}`
      edge += `${edge ? 'L' : 'M'}${sx(p.a)} ${sy(p.ctx)}L${sx(p.b)} ${sy(p.ctx)}`
    }
    path += `L${sx(run[run.length - 1].b)} ${g.y1}Z`
    s += `<path d="${path}" fill="url(#warm)"/><path d="${edge}" fill="none" stroke="${C_MAIN}" stroke-width="1.8" stroke-linejoin="round"/>`
    run = []
  }
  for (const p of pieces) {
    const contiguous = run.length && Math.abs(run[run.length - 1].b - p.a) < 1
    if (p.warm && (contiguous || !run.length)) run.push(p)
    else {
      flush()
      if (p.warm) run.push(p)
      else {
        const xa = sx(p.a)
        const xb = sx(p.b)
        s += `<rect x="${xa}" y="${sy(p.ctx)}" width="${Math.max(0, xb - xa)}" height="${g.y1 - sy(p.ctx)}" fill="url(#hatch)"/>`
        s += `<line x1="${xa}" y1="${sy(p.ctx)}" x2="${xb}" y2="${sy(p.ctx)}" stroke="rgba(128,128,128,.6)" stroke-width="1.2" stroke-dasharray="3 3"/>`
        if (xb - xa > 76) s += `<text x="${(xa + xb) / 2}" y="${(sy(p.ctx) + g.y1) / 2 + 4}" text-anchor="middle" class="s" font-size="11">缓存已过期</text>`
      }
    }
  }
  flush()

  // 未来：缓存还能保持到何时（接续保温开启时延伸到计划的最后一次保温之后 1 小时）
  const last = rs.length ? rs[rs.length - 1] : null
  const exp = last ? last.t + HOUR : now
  if (last && exp > now) {
    const planEnd = hours > 0 && lastReal !== null ? lastReal + hours * HOUR + HOUR : exp
    const fEnd = Math.min(t1, Math.max(exp, planEnd))
    s += `<rect x="${sx(now)}" y="${sy(last.ctx)}" width="${sx(fEnd) - sx(now)}" height="${g.y1 - sy(last.ctx)}" fill="url(#soft)"/>`
    s += `<line x1="${sx(now)}" y1="${sy(last.ctx)}" x2="${sx(fEnd)}" y2="${sy(last.ctx)}" stroke="${C_MAIN}" stroke-width="1.4" stroke-dasharray="4 3"/>`
  }
  s += hline(g, sy(compactAt), C_GOLD, `自动压缩 ${kfmt(compactAt)}`)

  // 请求刻痕与事件标记
  for (const q of vis) if (q.t >= t0) s += `<line x1="${sx(q.t)}" y1="${g.y1}" x2="${sx(q.t)}" y2="${g.y1 - 4}" stroke="${q.kind === 'hit' ? C_MAIN : q.kind === 'kw' ? C_GOLD : C_DARK}" stroke-width="0.8" opacity=".55"/>`
  let lastLabel = -100
  for (const q of vis) {
    if (q.t < t0) continue
    const x = sx(q.t)
    const y = sy(q.ctx)
    if (q.kind === 'kw') s += dia(x, y, 5, C_GOLD, '#fff')
    else if (q.kind !== 'hit') {
      s += `<circle cx="${x}" cy="${y}" r="4" fill="${C_DARK}" class="ring" stroke-width="1.5"/>`
      if (x - lastLabel > 74) {
        const text = q.kind === 'idle' ? `冷读取 +${usd(q.extra)}` : q.kind === 'compact' ? '压缩后重建' : '整段重写'
        s += `<text x="${x}" y="${y - 9}" text-anchor="middle" class="hl" font-size="10.5" font-weight="600">${text}</text>`
        lastLabel = x
      }
    }
  }
  if (hours > 0 && lastReal !== null && last) {
    const end = lastReal + hours * HOUR
    for (let t = Math.max(now, last.t + FIRE_MIN * 60000); t < end && t <= t1; t += FIRE_MIN * 60000) s += dia(sx(t), sy(last.ctx), 5, 'none', C_GOLD)
  }

  // 现在与到期
  s += `<line x1="${sx(now)}" y1="${g.y0 - 2}" x2="${sx(now)}" y2="${g.y1}" class="ax" stroke-width="1.2"/>`
  const expired = exp < now
  s += `<text x="${sx(now) + (expired ? 5 : -5)}" y="${g.y0 - 6}" text-anchor="${expired ? 'start' : 'end'}" class="p" font-size="11" font-weight="600">现在 ${hm(now)}</text>`
  if (last && exp > t0) {
    s += `<line x1="${sx(exp)}" y1="${g.y0 - 2}" x2="${sx(exp)}" y2="${g.y1}" stroke="${C_RED}" stroke-width="1.2" stroke-dasharray="4 3"/>`
    s += `<text x="${sx(exp) + (expired ? 5 : -5)}" y="${g.y0 + 14}" text-anchor="${expired ? 'start' : 'end'}" fill="${C_RED}" font-size="11" font-weight="600">缓存到期 ${hm(exp)}</text>`
  }
  // 当前上下文标在“现在”线右侧的预计区里；缓存已过期时标在有效段末端内侧
  if (last) {
    const lx = exp > now ? sx(now) + 6 : sx(exp) - 6
    s += `<text x="${lx}" y="${sy(last.ctx) + 17}" text-anchor="${exp > now ? 'start' : 'end'}" class="hl" font-size="12" font-weight="700">${kfmt(last.ctx)}</text>`
  }
  s += legend(g.h, [['area', C_MAIN, '缓存有效'], ['hatch', '', '已过期'], ['dot', C_DARK, '冷读取'], ['dia', C_GOLD, '保温'], ['odia', C_GOLD, '计划保温']])
  return doc(g.w, g.h, s)
}

// 图二：费用构成（空闲时段压缩）。自下而上：正常费用、无法避免的重建、保温花费、冷读取多付
function svgCost(d: any) {
  const g: G = { w: 480, h: 362, x0: 46, x1: 396, y0: 124, y1: 276 }
  const rs = d.reqs
  if (!rs.length) return doc(g.w, g.h, head('费用构成', '没有读到请求记录'))
  const L = ledger(rs)
  const { xs, breaks } = pack(rs, g)
  const pts = L.rows.map((r: any, i: number) => ({ ...r, x: xs[i] }))
  const total = L.base + L.rebuild + L.kw + L.cold
  const { max, step } = nice(Math.max(total, total - L.kw + L.avoided, 0.01) * 1.05)
  const sy = (v: number) => g.y1 - (v / max) * (g.y1 - g.y0)
  const sp = down(pts, 300)
  const line = (key: string) => sp.map((p: any) => `${p.x.toFixed(1)},${sy(p[key]).toFixed(1)}`)
  const band = (lo: string, hi: string, fill: string) => {
    const upper = line(hi)
    const lower = lo ? line(lo).reverse() : [`${sp[sp.length - 1].x.toFixed(1)},${g.y1}`, `${sp[0].x.toFixed(1)},${g.y1}`]
    return `<polygon points="${upper.join(' ')} ${lower.join(' ')}" fill="${fill}"/>`
  }

  let s = head('费用构成', '按列表价估算，不是账单；空闲超过 30 分钟的时段已压缩')
  // 顶部三项读数，颜色与图中色带一一对应
  const net = L.avoided - L.kw
  const kpi = [
    { kind: 'band', color: C_DARK, label: '冷读取多付', value: usd(L.cold), sub: `${L.coldN} 次` },
    { kind: 'band', color: C_GOLD, label: '保温花费', value: usd(L.kw), sub: `${L.kwN} 次` },
    { kind: 'dash', color: C_DARK, label: net >= 0 ? '保温净省' : '保温净花', value: usd(Math.abs(net)), sub: `避免 ${usd(L.avoided)}` },
  ]
  kpi.forEach((k, j) => {
    const x = 16 + j * 152
    s += swatch(k.kind, k.color, x, 72) + `<text x="${x + 17}" y="72" class="s" font-size="11">${k.label}</text>`
    s += `<text x="${x}" y="97" class="p" font-size="18" font-weight="700">${k.value}</text>`
    s += `<text x="${x + textW(k.value, 18) + 6}" y="97" class="s" font-size="11">${k.sub}</text>`
  })
  s += yAxis(g, max, step, v => `$${Number.isInteger(Math.round(v * 100) / 100) ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)}`) + breakMarks(g, xs, breaks) + packAxis(g, rs, xs, breaks)
  s += band('', 's1', 'url(#warm)')
  if (L.rebuild > 0) s += band('s1', 's2', 'rgba(128,128,128,.45)')
  if (L.kw > 0) s += band('s2', 's3', C_GOLD)
  if (L.cold > 0) s += band('s3', 's4', C_DARK)
  s += `<polyline fill="none" stroke="${C_MAIN}" stroke-width="2.2" stroke-linejoin="round" points="${line('s4').join(' ')}"/>`
  const labels = [{ y: sy(total), text: `总 ${usd(total)}`, color: C_MAIN }]
  if (L.kw > 0 || L.avoided > 0) {
    const k = Math.max(0, pts.findIndex((p: any) => Math.abs(p.cf - p.s4) > 0.005) - 1)
    const cf = pts.slice(k).map((p: any) => `${p.x.toFixed(1)},${sy(p.cf).toFixed(1)}`).join(' ')
    s += `<polyline fill="none" stroke="${C_DARK}" stroke-width="1.6" stroke-dasharray="5 3" stroke-linejoin="round" points="${cf}"/>`
    labels.push({ y: sy(total - L.kw + L.avoided), text: `不保温 ${usd(total - L.kw + L.avoided)}`, color: C_DARK })
  }
  // 每次冷读取在总费用线上标出多付的钱
  let lastX = -100
  pts.forEach((p: any, i: number) => {
    if (rs[i].kind !== 'idle') return
    s += `<circle cx="${p.x}" cy="${sy(p.s4)}" r="3.6" fill="${C_DARK}" class="ring" stroke-width="1.4"/>`
    if (p.x - lastX > 44) {
      const nearEdge = p.x > g.x1 - 30
      s += `<text x="${nearEdge ? p.x - 7 : p.x}" y="${sy(p.s4) - (nearEdge ? 3 : 8)}" text-anchor="${nearEdge ? 'end' : 'middle'}" class="hl" font-size="10.5" font-weight="600">+${usd(rs[i].extra)}</text>`
      lastX = p.x
    }
  })
  s += endLabels(g, labels)
  s += legend(g.h, [['area', C_MAIN, '正常对话'], ['band', 'rgba(128,128,128,.45)', '压缩或换模型后重建'], ['dash', C_DARK, '不保温时估算']])
  return doc(g.w, g.h, s)
}

// 图三：上下文长度（空闲时段压缩，按活动段断开）
function svgCtx(d: any) {
  const g: G = { w: 480, h: 340, x0: 46, x1: 464, y0: 70, y1: 256 }
  const rs = d.reqs
  if (!rs.length) return doc(g.w, g.h, head('上下文长度', '没有读到请求记录'))
  const { xs, breaks } = pack(rs, g)
  const top = rs.reduce((m: number, q: any) => Math.max(m, q.ctx), 0)
  const { max, step } = nice(Math.max(top, compactAt) * 1.06)
  const sy = (v: number) => g.y1 - (v / max) * (g.y1 - g.y0)
  let s = head('上下文长度', '三角为压缩发生处，尖端指向压缩前长度') + yAxis(g, max, step, kfmt) + breakMarks(g, xs, breaks) + packAxis(g, rs, xs, breaks)
  const cuts = [0, ...breaks.map(b => b.i), rs.length]
  for (let k = 0; k + 1 < cuts.length; k++) {
    const idx: number[] = []
    for (let i = cuts[k]; i < cuts[k + 1]; i++) idx.push(i)
    const sp = down(idx, 200)
    if (sp.length === 1) {
      s += `<circle cx="${xs[sp[0]]}" cy="${sy(rs[sp[0]].ctx)}" r="2.5" fill="${C_MAIN}"/>`
      continue
    }
    const line = sp.map((i: number) => `${xs[i].toFixed(1)},${sy(rs[i].ctx).toFixed(1)}`).join(' ')
    s += `<polygon points="${xs[sp[0]].toFixed(1)},${g.y1} ${line} ${xs[sp[sp.length - 1]].toFixed(1)},${g.y1}" fill="url(#warm)"/>`
    s += `<polyline fill="none" stroke="${C_MAIN}" stroke-width="2" stroke-linejoin="round" points="${line}"/>`
  }
  s += hline(g, sy(compactAt), C_GOLD, `自动压缩 ${kfmt(compactAt)}`)
  for (const m of d.comps) {
    let i = rs.findIndex((q: any) => q.t >= m.t)
    if (i < 0) i = rs.length - 1
    const x = xs[i]
    const y = sy(m.pre)
    const auto = m.trig === 'auto'
    s += `<path d="M${x - 6} ${y - 10}H${x + 6}L${x} ${y}Z" fill="${auto ? C_DARK : C_TEXT}"/>`
    s += `<text x="${x}" y="${y - 14}" text-anchor="middle" ${auto ? 'class="hl"' : 'class="s"'} font-size="10.5" font-weight="600">${kfmt(m.pre)}</text>`
  }
  const last = rs[rs.length - 1]
  s += `<circle cx="${xs[rs.length - 1]}" cy="${sy(last.ctx)}" r="3.6" fill="${C_DARK}" class="ring" stroke-width="1.4"/>`
  s += `<text x="${xs[rs.length - 1] - 7}" y="${sy(last.ctx) - 8}" text-anchor="end" class="hl" font-size="11.5" font-weight="700">${kfmt(last.ctx)}</text>`
  s += legend(g.h, [['area', C_MAIN, '上下文长度'], ['tri', C_DARK, '自动压缩'], ['tri', C_TEXT, '手动压缩'], ['dash', C_GOLD, '压缩阈值']])
  return doc(g.w, g.h, s)
}

// ---------- 长期汇总：按小时、天、周、月分格 ----------
const SPANS: Record<string, { n: number; desc: string; name: string }> = {
  hour: { n: 24, desc: '近 24 小时，按小时', name: '近 24 小时' },
  d7: { n: 7, desc: '近 7 天，按天', name: '近 7 天' },
  day: { n: 30, desc: '近 30 天，按天', name: '近 30 天' },
  week: { n: 12, desc: '近 12 周，按周', name: '近 12 周' },
  month: { n: 12, desc: '近 12 个月，按月', name: '近 12 个月' },
}
const C_BASE = '#F6B26B'
const C_REB = 'rgba(128,128,128,.45)'

// 分格边界按本地日历对齐（周从周一起），最后一格含现在
function edgesOf(unit: string, now: number) {
  const d = new Date(now)
  if (unit === 'hour') d.setMinutes(0, 0, 0)
  else {
    d.setHours(0, 0, 0, 0)
    if (unit === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    if (unit === 'month') d.setDate(1)
  }
  const out: number[] = []
  for (let k = 1 - SPANS[unit].n; k <= 1; k++) {
    const x = new Date(d.getTime())
    if (unit === 'hour') x.setHours(x.getHours() + k)
    else if (unit === 'day' || unit === 'd7') x.setDate(x.getDate() + k)
    else if (unit === 'week') x.setDate(x.getDate() + 7 * k)
    else x.setMonth(x.getMonth() + k)
    out.push(x.getTime())
  }
  return out
}

function binName(unit: string, t: number) {
  const d = new Date(t)
  if (unit === 'hour') return `${md(t)} ${p2(d.getHours())}时`
  if (unit === 'week') return `${md(t)} 起一周`
  if (unit === 'month') return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
  return md(t)
}

// 柱状图横轴：标签从最后一格往前每隔若干格标一个，至多 8 个；按小时时换日处加日期，按月时换年处加年份
function barAxis(g: G, unit: string, edges: number[]) {
  const nb = edges.length - 1
  const bw = (g.x1 - g.x0) / nb
  const every = Math.ceil(nb / 8)
  let s = ''
  let sub = ''
  for (let k = 0; k < nb; k++) {
    if ((nb - 1 - k) % every !== 0) continue
    const x = g.x0 + (k + 0.5) * bw
    const d = new Date(edges[k])
    const main = unit === 'hour' ? `${p2(d.getHours())}时` : unit === 'month' ? `${d.getMonth() + 1}月` : md(edges[k])
    s += `<line x1="${x}" y1="${g.y1}" x2="${x}" y2="${g.y1 + 4}" class="ax"/>`
    s += `<text x="${x}" y="${g.y1 + 17}" text-anchor="middle" class="s" font-size="11">${main}</text>`
    const second = unit === 'hour' ? md(edges[k]) : unit === 'month' ? `${d.getFullYear()}` : ''
    if (second && second !== sub) {
      sub = second
      s += `<text x="${x}" y="${g.y1 + 31}" text-anchor="middle" class="s" font-size="10.5" font-weight="600">${second}</text>`
    }
  }
  return { s, bw, cx: (k: number) => g.x0 + (k + 0.5) * bw }
}

// 一根堆叠柱：自下而上逐段画，段间留 0.6 像素缝
function stack(x: number, w: number, sy: (v: number) => number, parts: { v: number; fill: string }[]) {
  let s = ''
  let acc = 0
  for (const p of parts) {
    if (p.v <= 0) continue
    const yb = sy(acc)
    const yt = sy(acc + p.v)
    s += `<rect x="${x - w / 2}" y="${yt}" width="${w}" height="${Math.max(0.6, yb - yt - (acc > 0 ? 0.6 : 0))}" fill="${p.fill}"/>`
    acc += p.v
  }
  return s
}

// 柱顶小圆标：圆里写次数，柱太窄时只画圆
function badge(x: number, y: number, n: number, bw: number) {
  const r = bw >= 13 ? 6.5 : 4
  return `<circle cx="${x}" cy="${y - r - 2}" r="${r}" fill="${C_DARK}" class="ring" stroke-width="1.2"/>` + (r >= 6 ? `<text x="${x}" y="${y - r + 1.5}" text-anchor="middle" fill="#fff" font-size="9" font-weight="700">${n}</text>` : '')
}

function kpiRow(cold: number, coldN: number, kw: number, kwN: number, avoided: number) {
  const net = avoided - kw
  const kpi = [
    { kind: 'band', color: C_DARK, label: '冷读取多付', value: usd(cold), sub: `${coldN} 次` },
    { kind: 'band', color: C_GOLD, label: '保温花费', value: usd(kw), sub: `${kwN} 次` },
    { kind: 'dash', color: C_DARK, label: net >= 0 ? '保温净省' : '保温净花', value: usd(Math.abs(net)), sub: `避免 ${usd(avoided)}` },
  ]
  let s = ''
  kpi.forEach((k, j) => {
    const x = 16 + j * 152
    s += swatch(k.kind, k.color, x, 72) + `<text x="${x + 17}" y="72" class="s" font-size="11">${k.label}</text>`
    s += `<text x="${x}" y="97" class="p" font-size="18" font-weight="700">${k.value}</text>`
    s += `<text x="${x + textW(k.value, 18) + 6}" y="97" class="s" font-size="11">${k.sub}</text>`
  })
  return s
}

const mfmt = (v: number) => (v === 0 ? '0' : v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : kfmt(v))
const tot = (b: any) => b.base + b.rebuild + b.kw + b.cold
const sumOf = (bs: any[], k: string) => bs.reduce((m: number, b: any) => m + b[k], 0)

// 汇总图一：缓存写入按原因拆分。写入单价是读取的 40 倍，冷读取和重建都表现为写入突增
function aggWrite(a: any) {
  const g: G = { w: 480, h: 340, x0: 46, x1: 464, y0: 70, y1: 262 }
  const bs = a.b
  const { s: ax, bw, cx } = barAxis(g, a.unit, a.edges)
  const top = bs.reduce((m: number, b: any) => Math.max(m, b.cw), 0)
  const { max, step } = nice(Math.max(top, 1000) * 1.12)
  const sy = (v: number) => g.y1 - (v / max) * (g.y1 - g.y0)
  const all = sumOf(bs, 'cw')
  const share = all > 0 ? Math.round((100 * (sumOf(bs, 'cwIdle') + sumOf(bs, 'cwRe'))) / all) : 0
  let s = head('缓存写入', `全部项目 · ${SPANS[a.unit].desc}；整段重写占写入 ${share}%`) + yAxis(g, max, step, mfmt) + ax
  bs.forEach((b: any, k: number) => {
    if (b.cw <= 0) return
    s += stack(cx(k), bw * 0.66, sy, [
      { v: b.cwHit, fill: C_BASE },
      { v: b.cwRe, fill: C_REB },
      { v: b.cwKw, fill: C_GOLD },
      { v: b.cwIdle, fill: C_DARK },
    ])
    if (b.coldN > 0) s += badge(cx(k), sy(b.cw), b.coldN, bw)
  })
  s += legend(g.h, [['band', C_BASE, '对话增长'], ['band', C_REB, '压缩或换模型重建'], ['band', C_GOLD, '保温'], ['dot', C_DARK, '冷读取（数字为次数）']])
  return doc(g.w, g.h, s)
}

// 汇总图二：每格费用构成，虚线短横为不保温时的估算
function aggCost(a: any) {
  const g: G = { w: 480, h: 354, x0: 46, x1: 464, y0: 124, y1: 292 }
  const bs = a.b
  const { s: ax, bw, cx } = barAxis(g, a.unit, a.edges)
  const all = bs.reduce((m: number, b: any) => m + tot(b), 0)
  const top = bs.reduce((m: number, b: any) => Math.max(m, tot(b), tot(b) - b.kw + b.avoided), 0)
  const { max, step } = nice(Math.max(top, 0.01) * 1.12)
  const sy = (v: number) => g.y1 - (v / max) * (g.y1 - g.y0)
  let s = head('费用构成', `全部项目 · ${SPANS[a.unit].desc}；列表价估算，合计 ${usd(all)}`)
  s += kpiRow(sumOf(bs, 'cold'), sumOf(bs, 'coldN'), sumOf(bs, 'kw'), sumOf(bs, 'kwN'), sumOf(bs, 'avoided'))
  s += yAxis(g, max, step, v => `$${Number.isInteger(Math.round(v * 100) / 100) ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)}`) + ax
  let peak = -1
  bs.forEach((b: any, k: number) => {
    const t = tot(b)
    if (t <= 0) return
    if (peak < 0 || t > tot(bs[peak])) peak = k
    s += stack(cx(k), bw * 0.66, sy, [
      { v: b.base, fill: C_BASE },
      { v: b.rebuild, fill: C_REB },
      { v: b.kw, fill: C_GOLD },
      { v: b.cold, fill: C_DARK },
    ])
    if (b.kw > 0 || b.avoided > 0) {
      const y = sy(t - b.kw + b.avoided)
      s += `<line x1="${cx(k) - bw * 0.45}" y1="${y}" x2="${cx(k) + bw * 0.45}" y2="${y}" stroke="${C_DARK}" stroke-width="1.6" stroke-dasharray="3 2"/>`
    }
  })
  if (peak >= 0) {
    const x = cx(peak)
    const anchor = x > g.x1 - 30 ? 'end' : x < g.x0 + 30 ? 'start' : 'middle'
    s += `<text x="${x}" y="${sy(tot(bs[peak])) - 6}" text-anchor="${anchor}" class="hl" font-size="11" font-weight="600">${usd(tot(bs[peak]))}</text>`
  }
  s += legend(g.h, [['band', C_BASE, '正常对话'], ['band', C_REB, '压缩或换模型后重建'], ['dash', C_DARK, '不保温时估算']])
  return doc(g.w, g.h, s)
}

// 汇总图三：每格最长上下文（柱）与中位数（圆点），柱顶三角为压缩次数
function aggCtx(a: any) {
  const g: G = { w: 480, h: 340, x0: 46, x1: 464, y0: 70, y1: 256 }
  const bs = a.b
  const { s: ax, bw, cx } = barAxis(g, a.unit, a.edges)
  const top = bs.reduce((m: number, b: any) => Math.max(m, b.ctxMax), 0)
  const { max, step } = nice(Math.max(top, compactAt) * 1.12)
  const sy = (v: number) => g.y1 - (v / max) * (g.y1 - g.y0)
  const comps = sumOf(bs, 'compA') + sumOf(bs, 'compM')
  let s = head('上下文长度', `全部项目 · ${SPANS[a.unit].desc}；共压缩 ${comps} 次`) + yAxis(g, max, step, mfmt) + ax
  const w = bw * 0.66
  bs.forEach((b: any, k: number) => {
    if (b.ctxMax <= 0) return
    const x = cx(k)
    s += `<rect x="${x - w / 2}" y="${sy(b.ctxMax)}" width="${w}" height="${g.y1 - sy(b.ctxMax)}" fill="url(#warm)"/>`
    s += `<line x1="${x - w / 2}" y1="${sy(b.ctxMax)}" x2="${x + w / 2}" y2="${sy(b.ctxMax)}" stroke="${C_MAIN}" stroke-width="2"/>`
    s += `<circle cx="${x}" cy="${sy(b.ctxMed)}" r="${Math.min(3.4, bw * 0.22)}" fill="${C_DARK}" class="ring" stroke-width="1"/>`
    const n = b.compA + b.compM
    if (n > 0) {
      const y = sy(b.ctxMax) - 3
      s += `<path d="M${x - 4} ${y - 6}H${x + 4}L${x} ${y}Z" fill="${b.compA > 0 ? C_DARK : C_TEXT}"/>`
      if (bw >= 12) s += `<text x="${x}" y="${y - 9}" text-anchor="middle" class="hl" font-size="9.5" font-weight="600">${n}</text>`
    }
  })
  // 压缩标记都挤在阈值线上方，阈值文字改放线下
  s += hline(g, sy(compactAt), C_GOLD, `自动压缩 ${kfmt(compactAt)}`, true)
  s += legend(g.h, [['area', C_MAIN, '最长上下文'], ['dot', C_DARK, '中位数'], ['tri', C_DARK, '压缩次数'], ['dash', C_GOLD, '压缩阈值']])
  return doc(g.w, g.h, s)
}

// 7 天档的累计图用逐小时细格，柱状图仍按天
function hourlyEdges(t0: number, t1: number) {
  const out: number[] = []
  const x = new Date(t0)
  while (x.getTime() <= t1) {
    out.push(x.getTime())
    x.setHours(x.getHours() + 1)
  }
  return out
}

// 累计图横轴：按小时的档每 3 小时一个刻度、换日处加日期；7 天档在每天零点标日期；其余档同柱状图
function cumAxis(g: G, unit: string, edges: number[], sx: (t: number) => number) {
  const nb = edges.length - 1
  const idx: number[] = []
  if (unit === 'd7') {
    for (let k = 0; k <= nb; k++) if (new Date(edges[k]).getHours() === 0) idx.push(k)
  } else {
    const every = Math.ceil(nb / 8)
    for (let k = 0; k <= nb; k += every) idx.push(k)
  }
  let s = ''
  let sub = ''
  for (const k of idx) {
    const t = edges[k]
    const x = sx(t)
    const d = new Date(t)
    const main = unit === 'hour' ? `${p2(d.getHours())}时` : unit === 'month' ? `${d.getMonth() + 1}月` : md(t)
    s += `<line x1="${x}" y1="${g.y1}" x2="${x}" y2="${g.y1 + 4}" class="ax"/>`
    s += `<text x="${x}" y="${g.y1 + 17}" text-anchor="middle" class="s" font-size="11">${main}</text>`
    const second = unit === 'hour' ? md(t) : unit === 'month' ? `${d.getFullYear()}` : ''
    if (second && second !== sub) {
      sub = second
      s += `<text x="${x}" y="${g.y1 + 31}" text-anchor="middle" class="s" font-size="10.5" font-weight="600">${second}</text>`
    }
  }
  return s
}

// 累计图：费用（kind=cost）或缓存写入（kind=write），从范围起点累加到现在，自下而上分层与本会话费用图一致
function aggCum(a: any, kind: string) {
  const f = a.fine || a
  const now = a.at
  const isCost = kind === 'cost'
  const g: G = isCost ? { w: 480, h: 354, x0: 46, x1: 396, y0: 124, y1: 276 } : { w: 480, h: 340, x0: 46, x1: 396, y0: 70, y1: 256 }
  const e0 = f.edges[0]
  const eN = f.edges[f.edges.length - 1]
  const sx = (t: number) => g.x0 + ((t - e0) / (eN - e0)) * (g.x1 - g.x0)
  const K = isCost ? ['base', 'rebuild', 'kw', 'cold'] : ['cwHit', 'cwRe', 'cwKw', 'cwIdle']
  const acc = [0, 0, 0, 0]
  let kwAcc = 0
  let avAcc = 0
  const pts: any[] = [{ t: e0, s1: 0, s2: 0, s3: 0, s4: 0, cf: 0, cold: 0 }]
  f.b.forEach((b: any, k: number) => {
    if (f.edges[k] >= now) return
    K.forEach((key, j) => (acc[j] += b[key]))
    kwAcc += b.kw
    avAcc += b.avoided
    const s4 = acc[0] + acc[1] + acc[2] + acc[3]
    pts.push({ t: Math.min(f.edges[k + 1], now), s1: acc[0], s2: acc[0] + acc[1], s3: acc[0] + acc[1] + acc[2], s4, cf: s4 - kwAcc + avAcc, cold: b.coldN })
  })
  const last = pts[pts.length - 1]
  const showCf = isCost && (kwAcc > 0 || avAcc > 0)
  const { max, step } = nice(Math.max(last.s4, showCf ? last.cf : 0, isCost ? 0.01 : 1000) * 1.08)
  const sy = (v: number) => g.y1 - (v / max) * (g.y1 - g.y0)
  const line = (key: string) => pts.map((p: any) => `${sx(p.t).toFixed(1)},${sy(p[key]).toFixed(1)}`)
  const band = (lo: string, hi: string, fill: string) => {
    const lower = lo ? line(lo).reverse() : [`${sx(last.t).toFixed(1)},${g.y1}`, `${sx(e0).toFixed(1)},${g.y1}`]
    return `<polygon points="${line(hi).join(' ')} ${lower.join(' ')}" fill="${fill}"/>`
  }
  const fmt = isCost ? usd : mfmt
  let s = ''
  if (isCost) {
    s += head('费用构成', `全部项目 · ${SPANS[a.unit].name}累计；列表价估算，合计 ${usd(last.s4)}`)
    s += kpiRow(acc[3], sumOf(f.b, 'coldN'), acc[2], sumOf(f.b, 'kwN'), avAcc)
    s += yAxis(g, max, step, v => `$${Number.isInteger(Math.round(v * 100) / 100) ? v.toFixed(0) : v.toFixed(v < 1 ? 2 : 1)}`)
  } else {
    const share = last.s4 > 0 ? Math.round((100 * (acc[1] + acc[3])) / last.s4) : 0
    s += head('缓存写入', `全部项目 · ${SPANS[a.unit].name}累计；整段重写占写入 ${share}%`) + yAxis(g, max, step, mfmt)
  }
  s += cumAxis(g, a.unit, f.edges, sx)
  s += band('', 's1', 'url(#warm)')
  if (acc[1] > 0) s += band('s1', 's2', C_REB)
  if (acc[2] > 0) s += band('s2', 's3', C_GOLD)
  if (acc[3] > 0) s += band('s3', 's4', C_DARK)
  s += `<polyline fill="none" stroke="${C_MAIN}" stroke-width="2.2" stroke-linejoin="round" points="${line('s4').join(' ')}"/>`
  const labels = [{ y: sy(last.s4), text: `${isCost ? '总' : '共'} ${fmt(last.s4)}`, color: C_MAIN }]
  if (showCf) {
    const k = Math.max(0, pts.findIndex((p: any) => Math.abs(p.cf - p.s4) > 0.005) - 1)
    s += `<polyline fill="none" stroke="${C_DARK}" stroke-width="1.6" stroke-dasharray="5 3" stroke-linejoin="round" points="${line('cf').slice(k).join(' ')}"/>`
    labels.push({ y: sy(last.cf), text: `不保温 ${usd(last.cf)}`, color: C_DARK })
  }
  // 有冷读取的时段在总量线上打点
  for (const p of pts) if (p.cold > 0) s += `<circle cx="${sx(p.t)}" cy="${sy(p.s4)}" r="3.2" fill="${C_DARK}" class="ring" stroke-width="1.2"/>`
  // 现在：累计线停在这里，右侧是范围内尚未到来的时间
  if (now < eN) {
    s += `<line x1="${sx(now)}" y1="${g.y0}" x2="${sx(now)}" y2="${g.y1}" class="ax" stroke-dasharray="2 3"/>`
  }
  s += endLabels(g, labels)
  s += isCost
    ? legend(g.h, [['area', C_MAIN, '正常对话'], ['band', C_REB, '压缩或换模型后重建'], ['dash', C_DARK, '不保温时估算']])
    : legend(g.h, [['area', C_MAIN, '对话增长'], ['band', C_REB, '重建'], ['band', C_GOLD, '保温'], ['band', C_DARK, '冷读取重写'], ['dot', C_DARK, '有冷读取']])
  return doc(g.w, g.h, s)
}

function aggTable(a: any) {
  let t = '| 时段 | 请求 | 费用 | 冷读取 |\n|:--|--:|--:|--:|\n'
  const rows = a.b.map((b: any, k: number) => ({ b, t: a.edges[k] })).filter((r: any) => r.b.n > 0).slice(-8).reverse()
  for (const r of rows) t += `| ${binName(a.unit, r.t)} | ${r.b.n} | ${usd(tot(r.b))} | ${r.b.coldN} |\n`
  return rows.length ? t : '这段时间没有请求记录。'
}

function resetLabel(iso: string | undefined, now: number) {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ''
  return t - now < 20 * HOUR ? `${hm(t)} 重置` : `${md(t)} ${hm(t)} 重置`
}

// 顶部四格：上下文、缓存剩余、5 小时额度、本周额度
function tiles(d: any, now: number, u: any) {
  const rs = d.reqs
  const last = rs.length ? rs[rs.length - 1] : null
  const ctx = (u && u.context && u.context.tokens) || (last ? last.ctx : 0)
  const left = last ? Math.ceil((last.t + HOUR - now) / 60000) : 0
  const rl = (u && u.rateLimits) || []
  const quota = (label: string, kind: string) => {
    const r = rl.find((x: any) => x.kind === kind)
    if (!r) return { label, value: '暂无读数', aside: '下次回复后更新', frac: 0, color: C_MAIN }
    const rest = Math.max(0, 100 - r.percentUsed)
    return { label, value: `剩 ${Math.round(rest)}%`, aside: resetLabel(r.resetsAt, now), frac: rest / 100, color: rest < 10 ? C_RED : C_MAIN }
  }
  return [
    { label: '上下文', value: kfmt(ctx), aside: `压缩线 ${kfmt(compactAt)}`, frac: ctx / compactAt, color: ctx > 0.9 * compactAt ? C_RED : C_MAIN },
    {
      label: hours > 0 ? '缓存剩余 · 接续保温中' : '缓存剩余',
      value: left > 0 ? `${left} 分钟` : '已过期',
      aside: last ? (left > 0 ? `${hm(last.t + HOUR)} 到期` : '下次请求将冷读取') : '',
      frac: Math.max(0, left) / 60,
      color: left <= 10 ? C_RED : C_MAIN,
    },
    quota('5 小时额度', 'five_hour'),
    quota('本周额度', 'seven_day'),
  ]
}

function svgTiles(ts: any[]) {
  const w = 480
  const gap = 10
  const tw = (w - gap) / 2
  const th = 84
  const rows = Math.ceil(ts.length / 2)
  const h = rows * th + (rows - 1) * gap
  let s = ''
  ts.forEach((t: any, k: number) => {
    const x = (k % 2) * (tw + gap)
    const y = Math.floor(k / 2) * (th + gap)
    const bw = tw - 32
    const f = Math.max(0, Math.min(1, t.frac))
    s += `<rect x="${x}" y="${y}" width="${tw}" height="${th}" rx="12" class="bg"/>`
    s += `<text x="${x + 16}" y="${y + 25}" class="s">${t.label}</text>`
    s += `<text x="${x + 16}" y="${y + 54}" class="p" font-size="22" font-weight="600">${t.value}</text>`
    s += `<text x="${x + tw - 16}" y="${y + 54}" text-anchor="end" class="s" font-size="11.5">${t.aside}</text>`
    s += `<rect x="${x + 16}" y="${y + 66}" width="${bw}" height="6" rx="3" class="tr"/>`
    if (f > 0) s += `<rect x="${x + 16}" y="${y + 66}" width="${Math.max(6, bw * f)}" height="6" rx="3" fill="${t.color}"/>`
  })
  return doc(w, h, s, false)
}

// 明细只留四列，窄面板也不出横向滚动
function recentTable(d: any) {
  let t = '| 时间 | 类型 | 上下文 | 费用 |\n|:--|:--|--:|--:|\n'
  for (const q of d.reqs.slice(-8).reverse()) t += `| ${hm(q.t)} | ${KIND_NAME[q.kind] || q.kind} | ${kfmt(q.ctx)} | ${usd(q.cost)} |\n`
  return t
}

function summaryLines(d: any, now: number, u: any) {
  return tiles(d, now, u).map((t: any) => `${t.label}：${t.value}${t.aside ? `（${t.aside}）` : ''}`)
}

// ---------- 带 $ 的函数 ----------
async function loadData($: any) {
  loadError = ''
  try {
    const sid = await $.session.id()
    const r = await $.process.run(['python', '-c', PY, sid], { timeoutMs: 60000 })
    if (r.exitCode !== 0) throw new Error((r.stderr || '').slice(0, 200) || `退出码 ${r.exitCode}`)
    data = prep(JSON.parse(r.stdout))
  } catch (err: any) {
    data = null
    loadError = String(err && err.message ? err.message : err)
  }
  try {
    const u = await $.session.usage({ breakdown: 'summary' })
    const th = u && u.context && u.context.breakdown ? u.context.breakdown.autoCompactThreshold : undefined
    if (typeof th === 'number' && th > 0) compactAt = th
  } catch (err) {
    // 读不到阈值时沿用后备值
  }
}

// 长期汇总：扫描全部项目的会话记录（只取用量与压缩元数据），按时段分格；五分钟内重复查看直接用上次结果
async function loadAgg($: any, force = false) {
  const want = span
  if (want === 'ses' || aggBusy) return
  const now = await $.clock.now()
  if (!force && agg && agg.unit === want && now - aggAt < 5 * 60000) return
  aggBusy = true
  aggError = ''
  $.ui.invalidate('ui.render')
  try {
    const kw: number[] = []
    for (const k of (await $.store.keys()).filter((k: string) => k.startsWith('kw:'))) {
      const v = await $.store.get(k)
      if (Array.isArray(v)) for (const x of v) if (typeof x === 'number') kw.push(x)
    }
    const edges = edgesOf(want, now)
    const main = await runAgg($, edges, kw)
    const fineEdges = want === 'd7' ? hourlyEdges(edges[0], edges[edges.length - 1]) : null
    const fine = fineEdges ? { ...(await runAgg($, fineEdges, kw)), edges: fineEdges } : null
    agg = { ...main, edges, unit: want, at: now, fine }
    aggAt = now
  } catch (err: any) {
    agg = null
    aggError = String(err && err.message ? err.message : err)
  }
  aggBusy = false
  $.ui.invalidate('ui.render')
  if (span !== want && span !== 'ses') void loadAgg($)
}

async function runAgg($: any, edges: number[], kw: number[]) {
  const r = await $.process.run(['python', '-c', AGG_PY], { stdin: JSON.stringify({ edges, kw }), timeoutMs: 300000 })
  if (r.exitCode !== 0) throw new Error((r.stderr || '').slice(0, 200) || `退出码 ${r.exitCode}`)
  return JSON.parse(r.stdout)
}

async function readUsage($: any) {
  try {
    return await $.session.usage()
  } catch (err) {
    return null
  }
}

// 面板开着时每轮结束后重读记录，图与明细跟着更新
async function refreshIfOpen($: any) {
  if (!paneOpen) return
  await loadData($)
  $.ui.invalidate('ui.render')
  void loadAgg($)
}

async function openChart($: any, force = false) {
  await loadData($)
  paneOpen = true
  await $.ui.open({ id: PANE, title: '保温图表', closeOnEscape: true })
  $.ui.invalidate('ui.render')
  void loadAgg($, force)
}

// 保温时刻存进插件自己的持久存储，重载后仍能在图上认出保温请求；只记时刻，不读对话内容
async function loadKw($: any) {
  try {
    const v = await $.store.get(`kw:${await $.session.id()}`)
    if (Array.isArray(v)) kwTimes = v.filter((x: unknown) => typeof x === 'number')
  } catch (err) {
    // 读不到时只影响图上的保温标记
  }
}

async function saveKw($: any) {
  try {
    await $.store.set(`kw:${await $.session.id()}`, kwTimes)
    const keys = (await $.store.keys()).filter((k: string) => k.startsWith('kw:'))
    for (const k of keys.slice(0, Math.max(0, keys.length - 30))) await $.store.delete(k)
  } catch (err) {
    // 存不下时只影响图上的保温标记
  }
}

// 重载或撤回后模块变量会清空：用记录里最近一次请求的时刻接上，读不到就当作刚活动过
async function initLast($: any) {
  await loadKw($)
  await loadData($)
  const rs = data ? data.reqs : []
  lastAt = rs.length ? rs[rs.length - 1].t : await $.clock.now()
  $.ui.invalidate('ui.render')
}

async function fireKeepWarm($: any) {
  // 发出前先记时刻：插件自己的 $.prompt.submit 不经过本插件的 prompt.submit 钩子（claude plugin test 实测）
  const t = await $.clock.now()
  kwTimes = [...kwTimes, t].slice(-200)
  void saveKw($)
  try {
    await $.prompt.submit({ text: PROMPT, asUser: true })
  } catch (err) {
    kwTimes = kwTimes.filter(k => k !== t)
    void saveKw($)
    $.ui.toast(`保温请求未发出：${String((err as any)?.message || err).slice(0, 80)}`)
  }
}

async function everyMinute($: any) {
  if (lastAt === null) return
  const t = await $.clock.now()
  const idle = Math.floor((t - lastAt) / 60000)
  if (hours > 0 && lastReal !== null) {
    if (t >= lastReal + hours * 3600000) {
      hours = 0
      $.ui.toast(`接续保温已到时限并停止，共发送 ${sent} 次`)
    } else if (!busy && idle >= FIRE_MIN) {
      sent += 1
      void fireKeepWarm($)
    }
  }
  const left = lastReal === null ? 0 : Math.max(0, Math.ceil((lastReal + hours * 3600000 - t) / 60000))
  $.ui.status(hours > 0 ? `保温中，剩 ${Math.floor(left / 60)}h${left % 60}m，已发 ${sent} 次` : idle >= 15 ? `缓存闲置 ${idle} 分` : undefined)
  $.ui.invalidate('ui.render')
}

export const register: Register = on => {
  const leftMin = (t: number) => (lastReal === null ? 0 : Math.max(0, Math.ceil((lastReal + hours * 3600000 - t) / 60000)))

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'keepwarm',
      description: '/keepwarm 发一次保温；/keepwarm 8 接续保温 8 小时（上限 24）；/keepwarm off 停止；/keepwarm chart 打开图表',
    })
    $.clock.every(60000, () => {
      void everyMinute($)
    })
    void initLast($)
    return next(e)
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === '') {
      // 命令钩子里直接提交会被宿主拒绝（会等待本钩子占着的回合），改为命令返回后再发
      $.clock.after(500, () => {
        void fireKeepWarm($)
      })
      return { text: '保温请求将在半秒后发出。' }
    }
    if (arg === 'chart' || arg === '图表') {
      void openChart($)
      return { text: '正在打开保温图表。' }
    }
    if (arg === 'off' || arg === '停' || arg === '0') {
      hours = 0
      $.ui.invalidate('ui.render')
      return { text: `接续保温已停止，本次共发送 ${sent} 次。` }
    }
    const n = Number(arg)
    if (!Number.isFinite(n) || n <= 0) return { text: '用法：/keepwarm 发一次；/keepwarm 8 接续 8 小时；/keepwarm off 停止；/keepwarm chart 图表。' }
    if (n > MAX_HOURS) return { text: `拒绝：上限 ${MAX_HOURS} 小时（Claude Code 每日清理缓存的时刻未核实）。请设 ${MAX_HOURS} 以内的数。` }
    const t = await $.clock.now()
    hours = n
    sent = 0
    lastReal = t
    lastAt = lastAt ?? t
    $.ui.invalidate('ui.render')
    return { text: `接续保温已开启：从现在起 ${n} 小时内，闲置满 ${FIRE_MIN} 分钟就自动发一次保温。你一发言，时限从那一刻重新起算。电脑休眠或关闭窗口期间不会发送。` }
  })

  on('prompt.submit', async ($, e, next) => {
    const t = await $.clock.now()
    lastAt = t
    busy = true
    if (e.text === PROMPT) {
      // 本插件发出的保温已在 fireKeepWarm 记下；这里只接住手动粘贴的同一句提示
      if (!kwTimes.some(k => Math.abs(k - t) < 5000)) {
        kwTimes = [...kwTimes, t].slice(-200)
        void saveKw($)
      }
    } else lastReal = t // 保温请求本身不重置时限
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    lastAt = await $.clock.now()
    busy = false
    $.ui.invalidate('ui.render')
    void refreshIfOpen($)
    return next(e)
  })

  // 压缩不经过 turn.complete：主对话压缩完成后稍等记录写入压缩元数据，再重读一次
  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId && e.trigger !== 'precompute' && !(r as any)?.skip) {
      $.clock.after(2000, () => {
        void refreshIfOpen($)
      })
    }
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || lastAt === null) return next(e)
    const t = await $.clock.now()
    const idle = Math.floor((t - lastAt) / 60000)
    if (hours === 0 && idle < SHOW_MIN) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const note =
      hours > 0
        ? `接续保温开启：到时限还剩 ${Math.floor(leftMin(t) / 60)} 小时 ${leftMin(t) % 60} 分，已发 ${sent} 次`
        : idle >= 60
          ? `缓存已闲置 ${idle} 分钟，很可能已过期`
          : `缓存已闲置 ${idle} 分钟，约 ${60 - idle} 分钟后过期`
    return (
      <Box>
        <Text dimColor={hours === 0 && idle < WARN_MIN} bold={hours === 0 && idle >= WARN_MIN}>{note}{' '}</Text>
        <Button key="keepwarm" label="保温一次" onPress={() => fireKeepWarm($)} />
        <Button key="chart" label="图表" onPress={() => openChart($)} />
        {hours > 0 ? <Button key="stop" label="停止接续" onPress={() => { hours = 0; $.ui.status(undefined); $.ui.toast('接续保温已停止'); $.ui.invalidate('ui.render') }} /> : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui: any = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const tabs = [['line', span === 'ses' ? '缓存时间线' : '缓存写入'], ['cost', '费用构成'], ['ctx', '上下文长度']]
    const bar = (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
        <Box flexDirection="row" gap={1}>
          {tabs.map(tab => (
            <Button key={tab[0]} label={tab[1]} variant={view === tab[0] ? 'primary' : 'secondary'} onPress={() => { view = tab[0]; $.ui.invalidate('ui.render') }} />
          ))}
        </Box>
        <Button key="refresh" label="刷新" dimColor onPress={() => openChart($, true)} />
      </Box>
    )
    const spans = [['ses', '本会话'], ['hour', '24 小时'], ['d7', '7 天'], ['day', '30 天'], ['week', '12 周'], ['month', '12 个月']]
    const bar2 = (
      <Box flexDirection="row" alignItems="center" flexWrap="wrap" gap={1}>
        <Text dimColor>时间范围</Text>
        {spans.map(sp => (
          <Button key={`span-${sp[0]}`} label={sp[1]} variant={span === sp[0] ? 'primary' : 'secondary'} onPress={() => { span = sp[0]; $.ui.invalidate('ui.render'); void loadAgg($) }} />
        ))}
        {span !== 'ses' && view !== 'ctx' ? <Text dimColor>{'  显示'}</Text> : null}
        {span !== 'ses' && view !== 'ctx'
          ? [['seg', '每段'], ['cum', '累计']].map(m => (
              <Button key={`mode-${m[0]}`} label={m[1]} variant={!!cumBy[span] === (m[0] === 'cum') ? 'primary' : 'secondary'} onPress={() => { cumBy = { ...cumBy, [span]: m[0] === 'cum' }; $.ui.invalidate('ui.render') }} />
            ))
          : null}
      </Box>
    )
    if (!data) {
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {bar}
          {bar2}
          <Text dimColor>{loadError ? `读取失败：${loadError}` : '正在读取本会话的用量记录……'}</Text>
        </Box>
      )
    }
    const now = await $.clock.now()
    const u = await readUsage($)
    if (e.surface === 'terminal') {
      return (
        <Box flexDirection="column">
          {bar}
          {summaryLines(data, now, u).map((l: string, i: number) => (
            <Text key={`l${i}`}>{l}</Text>
          ))}
          <Text dimColor>终端里不画图，图表在桌面应用中显示。</Text>
        </Box>
      )
    }
    const { Svg, Markdown } = ui
    const tileSvg = <Svg source={svgTiles(tiles(data, now, u))} alt="上下文、缓存剩余、5 小时与本周额度" />
    if (span !== 'ses') {
      const ready = agg && agg.unit === span
      if (!ready) {
        return (
          <Box flexDirection="column" gap={1} padding={1}>
            {bar}
            {bar2}
            {tileSvg}
            <Text dimColor>{aggError && !aggBusy ? `汇总失败：${aggError}` : '正在汇总全部项目的用量记录……首次约需 10 秒，之后有缓存会快很多。'}</Text>
          </Box>
        )
      }
      const cum = !!cumBy[span] && view !== 'ctx'
      const achart = view === 'ctx' ? aggCtx(agg) : cum ? aggCum(agg, view === 'cost' ? 'cost' : 'write') : view === 'cost' ? aggCost(agg) : aggWrite(agg)
      const aalt = view === 'ctx' ? '各时段最长与中位上下文及压缩次数' : `${view === 'cost' ? '费用构成' : '缓存写入'}${cum ? '累计曲线' : '各时段柱状图'}`
      return (
        <Box flexDirection="column" gap={1} padding={1}>
          {bar}
          {bar2}
          {tileSvg}
          <Svg source={achart} alt={aalt} />
          <Text bold>最近有请求的时段</Text>
          <Markdown text={aggTable(agg)} />
        </Box>
      )
    }
    const chart = view === 'cost' ? svgCost(data) : view === 'ctx' ? svgCtx(data) : svgLine(data, now)
    const alt = view === 'cost' ? '本会话费用构成：正常对话、重建、保温花费与冷读取多付' : view === 'ctx' ? '本会话上下文长度与压缩' : '最近三小时的缓存时间线'
    return (
      <Box flexDirection="column" gap={1} padding={1}>
        {bar}
        {bar2}
        {tileSvg}
        <Svg source={chart} alt={alt} />
        <Text bold>最近请求</Text>
        <Markdown text={recentTable(data)} />
      </Box>
    )
  })
}
