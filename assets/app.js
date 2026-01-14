/* global Fuse, Chart, pako */
(function(){
  let projects = [];
  let buckets = [];
  let fuse = null;

  let lastSearch = {
    query: "",
    mode: "fuzzy",
    limit: 30,
    yearFrom: null,
    yearTo: null,
    pattern: "",
    results: [],
    charts: { years: null, patterns: null }
  };

  let charts = { years: null, patterns: null };
  let graphCharts = { year: null, timeline: null, gaps: null };
  let lastEvaluation = null;
  let lastGraph = null;
  let lastGraphSearch = null;
  let lastGraphAnalysis = null;
  let graphViewState = {
    selected: null,
    dragging: null,
    pointerId: null,
    panning: false,
    panStart: null,
    view: { scale: 1, offsetX: 0, offsetY: 0, minScale: 0.5, maxScale: 2.5 }
  };
  let graphSimulation = { running: false, dragging: false, until: 0, animId: null };

  let vectorState = {
    metadata: [],
    embeddings: null,
    norms: null,
    dim: 0,
    count: 0,
    inverted: null,
    idf: null,
    ready: false,
    source: null
  };
  let vectorWorker = null;
  let vectorWorkerReady = false;
  const workerRequests = new Map();
  let workerSeq = 1;
  const graphCache = new Map();
  let precomputedGraph = null;

  const el = (id) => document.getElementById(id);

  const fileProjects = el("fileProjects");
  const fileBuckets  = el("fileBuckets");
  const fileVectors  = el("fileVectors");
  const fileMetadata = el("fileMetadata");
  const fileEmbeddings = el("fileEmbeddings");
  const fileGraph = el("fileGraph");
  const fileInverted = el("fileInverted");
  const projectsStatus = el("projectsStatus");
  const bucketsStatus  = el("bucketsStatus");
  const vectorsStatus  = el("vectorsStatus");
  const vectorAssetStatus = el("vectorAssetStatus");
  const btnBuildIndex  = el("btnBuildIndex");
  const indexStatus    = el("indexStatus");

  const q = el("q");
  const btnSearch = el("btnSearch");
  const limitEl = el("limit");
  const yearFromEl = el("yearFrom");
  const yearToEl = el("yearTo");
  const patternFilter = el("patternFilter");
  const btnResetFilters = el("btnResetFilters");

  const resultsMeta = el("resultsMeta");
  const resultsEl = el("results");

  const providerEl = el("provider");
  const orModelEl = el("orModel");
  const orModelCustomEl = el("orModelCustom");
  const apiKeyEl = el("apiKey");
  const proposalTitleEl = el("proposalTitle");
  const proposalQueryEl = el("proposalQuery");
  const temperatureEl = el("temperature");
  const ragKEl = el("ragK");
  const ragMEl = el("ragM");
  const btnEvaluate = el("btnEvaluate");
  const evalStatus = el("evalStatus");
  const llmOutput = el("llmOutput");

  const btnDownloadJSON = el("btnDownloadJSON");
  const btnDownloadMD = el("btnDownloadMD");
  const btnDownloadHTML = el("btnDownloadHTML");
  const btnExportAll = el("btnExportAll");
  const btnClearStorage = el("btnClearStorage");

  const tabs = Array.from(document.querySelectorAll(".tab"));
  const panels = Array.from(document.querySelectorAll(".tab-panel"));

  const graphQueryEl = el("graphQuery");
  const graphModeEl = el("graphMode");
  const graphTopKEl = el("graphTopK");
  const graphThresholdEl = el("graphThreshold");
  const graphNodeLimitEl = el("graphNodeLimit");
  const graphEdgeLimitEl = el("graphEdgeLimit");
  const btnBuildGraph = el("btnBuildGraph");
  const btnAnalyzeGraph = el("btnAnalyzeGraph");
  const graphStatus = el("graphStatus");
  const graphMeta = el("graphMeta");
  const graphTop = el("graphTop");
  const graphCanvas = el("graphCanvas");
  const graphOverview = el("graphOverview");
  const graphYearTrend = el("graphYearTrend");
  const graphClusters = el("graphClusters");
  const graphCooccurrence = el("graphCooccurrence");
  const graphAnalysis = el("graphAnalysis");
  const graphTimeline = el("graphTimeline");
  const graphGaps = el("graphGaps");

  function setStatus(node, text, ok=null){
    node.textContent = text;
    if(ok === true) node.style.color = "var(--ok)";
    else if(ok === false) node.style.color = "var(--danger)";
    else node.style.color = "var(--muted)";
  }

  async function readFileAsText(file){
    return new Promise((resolve, reject)=>{
      const fr = new FileReader();
      fr.onload = ()=> resolve(fr.result);
      fr.onerror = reject;
      fr.readAsText(file, "utf-8");
    });
  }
  async function readFileAsArrayBuffer(file){
    return new Promise((resolve, reject)=>{
      const fr = new FileReader();
      fr.onload = ()=> resolve(fr.result);
      fr.onerror = reject;
      fr.readAsArrayBuffer(file);
    });
  }

  function parseJsonl(text){
    const out = [];
    const lines = text.split(/\r?\n/);
    for(const line of lines){
      const s = line.trim();
      if(!s) continue;
      try{ out.push(JSON.parse(s)); }catch(e){}
    }
    return out;
  }

  function normalizeStr(s){ return (s||"").toString().trim(); }
  function normalizeQueryTerms(text){
    return normalizeStr(text).toLowerCase().split(/\s+/).filter(Boolean);
  }
  function normalizeTokens(text){
    const raw = normalizeStr(text);
    if(!raw) return [];
    return raw.toLowerCase().split(/\s+/).filter(Boolean);
  }
  function getMode(){
    const checked = document.querySelector('input[name="mode"]:checked');
    return checked ? checked.value : "fuzzy";
  }
  function clampInt(x, min, max){
    const n = Number.parseInt(x, 10);
    if(Number.isNaN(n)) return null;
    return Math.max(min, Math.min(max, n));
  }
  function safeYear(x){
    const n = Number.parseInt(x, 10);
    return Number.isFinite(n) ? n : null;
  }
  function inYearRange(y, yFrom, yTo){
    if(y == null) return true;
    if(yFrom != null && y < yFrom) return false;
    if(yTo != null && y > yTo) return false;
    return true;
  }
  function hasPattern(rec, pattern){
    if(!pattern) return true;
    const ps = (rec.nlp && rec.nlp.pattern_markers) ? rec.nlp.pattern_markers : [];
    return ps.includes(pattern);
  }
  function buildPatternOptions(){
    const counts = new Map();
    for(const p of projects){
      const ps = (p.nlp && p.nlp.pattern_markers) ? p.nlp.pattern_markers : [];
      for(const t of ps){ counts.set(t, (counts.get(t)||0) + 1); }
    }
    const arr = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 40);
    patternFilter.innerHTML = '<option value="">不限制</option>';
    for(const [name, c] of arr){
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = `${name}（${c}）`;
      patternFilter.appendChild(opt);
    }
  }
  function makeSearchableText(p){
    const title = normalizeStr(p.title);
    const tokens = p.nlp && p.nlp.tokens ? p.nlp.tokens.join(" ") : "";
    const phrases = p.nlp && p.nlp.phrases ? p.nlp.phrases.join(" ") : "";
    const patterns = p.nlp && p.nlp.pattern_markers ? p.nlp.pattern_markers.join(" ") : "";
    return [title, tokens, phrases, patterns].join(" ");
  }
  function buildFuseIndex(){
    const list = projects.map((p, idx)=>({
      __idx: idx,
      id: normalizeStr(p.id),
      year: safeYear(p.year),
      title: normalizeStr(p.title),
      text: makeSearchableText(p)
    }));
    fuse = new Fuse(list, {
      includeScore: true,
      shouldSort: true,
      threshold: 0.38,
      ignoreLocation: true,
      minMatchCharLength: 2,
      keys: [
        { name: "title", weight: 0.6 },
        { name: "text", weight: 0.4 }
      ]
    });
  }
  function exactSearch(query){
    const terms = query.split(/\s+/).map(t=>t.trim()).filter(Boolean);
    const yFrom = safeYear(yearFromEl.value);
    const yTo = safeYear(yearToEl.value);
    const pat = patternFilter.value;

    const out = [];
    for(let i=0;i<projects.length;i++){
      const p = projects[i];
      const year = safeYear(p.year);
      if(!inYearRange(year, yFrom, yTo)) continue;
      if(!hasPattern(p, pat)) continue;

      const text = makeSearchableText(p);
      let ok = true;
      for(const t of terms){
        if(!text.includes(t)){ ok=false; break; }
      }
      if(ok) out.push({ item: { __idx:i }, score: 0.0 });
    }
    return out;
  }
  function fuzzySearch(query){
    const yFrom = safeYear(yearFromEl.value);
    const yTo = safeYear(yearToEl.value);
    const pat = patternFilter.value;

    const raw = fuse.search(query);
    const out = [];
    for(const r of raw){
      const p = projects[r.item.__idx];
      const year = safeYear(p.year);
      if(!inYearRange(year, yFrom, yTo)) continue;
      if(!hasPattern(p, pat)) continue;
      out.push(r);
    }
    return out;
  }
  function escapeHtml(s){
    return (s||"").toString()
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }
  function ensureNumber(x, fallback){
    const n = Number(x);
    return Number.isFinite(n) ? n : fallback;
  }
  function ensureVectorWorker(){
    if(vectorWorker) return;
    try{
      vectorWorker = new Worker("assets/vector-worker.js");
    }catch(e){
      vectorWorker = null;
      vectorWorkerReady = false;
      return;
    }
    vectorWorker.onmessage = (e)=>{
      const data = e.data || {};
      if(data.id){
        const req = workerRequests.get(data.id);
        if(!req) return;
        workerRequests.delete(data.id);
        if(data.ok === false) req.reject(new Error(data.error || "Worker error"));
        else req.resolve(data);
      }
    };
    vectorWorker.onerror = (e)=>{
      workerRequests.forEach((req, id)=>{
        req.reject(new Error("Worker 加载失败"));
        workerRequests.delete(id);
      });
    };
  }
  function workerCall(type, payload, transfer){
    ensureVectorWorker();
    if(!vectorWorker) return Promise.reject(new Error("Worker 不可用"));
    const id = workerSeq++;
    return new Promise((resolve, reject)=>{
      workerRequests.set(id, { resolve, reject });
      const message = Object.assign({ id, type }, payload || {});
      if(transfer && transfer.length){
        vectorWorker.postMessage(message, transfer);
      }else{
        vectorWorker.postMessage(message);
      }
    });
  }
  function updateVectorAssetStatus(text, ok){
    if(!vectorAssetStatus) return;
    if(text){
      setStatus(vectorAssetStatus, text, ok);
      return;
    }
    const parts = [];
    if(vectorState.metadata.length) parts.push(`metadata ${vectorState.metadata.length} 条`);
    if(vectorState.embeddings) parts.push(`embeddings ${vectorState.count} 条`);
    if(vectorState.inverted) parts.push(`倒排索引 ${Object.keys(vectorState.inverted).length} 词`);
    setStatus(vectorAssetStatus, parts.length ? parts.join(" · ") : "未加载", parts.length > 0);
  }
  function buildInvertedIndex(metadata){
    const index = Object.create(null);
    for(let i=0;i<metadata.length;i++){
      const tokens = metadata[i].tokensArr || [];
      const seen = new Set();
      for(const t of tokens){
        if(seen.has(t)) continue;
        seen.add(t);
        if(!index[t]) index[t] = [];
        index[t].push(i);
      }
    }
    return index;
  }
  function buildIdf(metadata){
    const df = new Map();
    for(const m of metadata){
      const tokens = m.tokensArr || [];
      const seen = new Set(tokens);
      for(const t of seen){
        df.set(t, (df.get(t)||0) + 1);
      }
    }
    const N = metadata.length || 1;
    const idf = Object.create(null);
    for(const [t, c] of df.entries()){
      idf[t] = Math.log(N / (c + 1));
    }
    return idf;
  }
  function computeEmbeddingNorms(embeddings, count, dim){
    const norms = new Float32Array(count);
    for(let i=0;i<count;i++){
      let sum = 0;
      const offset = i * dim;
      for(let j=0;j<dim;j++){
        const v = embeddings[offset + j];
        sum += v * v;
      }
      norms[i] = Math.sqrt(sum);
    }
    return norms;
  }
  function cosineLocal(indexA, indexB){
    const emb = vectorState.embeddings;
    const norms = vectorState.norms;
    if(!emb || !norms) return null;
    const normA = norms[indexA] || 0;
    const normB = norms[indexB] || 0;
    if(normA === 0 || normB === 0) return null;
    const dim = vectorState.dim;
    let dot = 0;
    const offsetA = indexA * dim;
    const offsetB = indexB * dim;
    for(let j=0;j<dim;j++){
      dot += emb[offsetA + j] * emb[offsetB + j];
    }
    return dot / (normA * normB);
  }
  function cosineQueryLocal(queryVec, index){
    const emb = vectorState.embeddings;
    const norms = vectorState.norms;
    if(!emb || !norms) return null;
    const normB = norms[index] || 0;
    if(normB === 0) return null;
    let normQ = 0;
    for(let i=0;i<queryVec.length;i++) normQ += queryVec[i] * queryVec[i];
    normQ = Math.sqrt(normQ);
    if(normQ === 0) return null;
    const dim = vectorState.dim;
    let dot = 0;
    const offset = index * dim;
    for(let j=0;j<dim;j++){
      const q = queryVec[j] || 0;
      dot += q * emb[offset + j];
    }
    return dot / (normQ * normB);
  }
  function tfidfSearch(query, topK){
    const terms = normalizeQueryTerms(query);
    if(terms.length === 0) return [];
    const candidates = new Set();
    if(vectorState.inverted){
      for(const t of terms){
        const hits = vectorState.inverted[t];
        if(hits) hits.forEach(idx=>candidates.add(idx));
      }
    }
    const useAll = candidates.size === 0;
    const results = [];
    const idf = vectorState.idf || {};
    const iterate = useAll ? vectorState.metadata.map((_, idx)=>idx) : Array.from(candidates);
    for(const idx of iterate){
      const meta = vectorState.metadata[idx];
      if(!meta) continue;
      let score = 0;
      for(const t of terms){
        if(meta.tokensSet && meta.tokensSet.has(t)) score += (idf[t] || 0);
        else if(meta.nameLower && meta.nameLower.includes(t)) score += 0.4;
      }
      if(score > 0) results.push({ index: idx, score });
    }
    results.sort((a,b)=>b.score - a.score);
    return results.slice(0, topK);
  }
  function renderResults(list){
    resultsEl.innerHTML = "";
    const limit = clampInt(limitEl.value, 1, 500) || 30;

    const sliced = list.slice(0, limit).map(r => {
      const idx = r.item.__idx;
      return { rec: projects[idx], score: r.score ?? 0 };
    });

    resultsMeta.textContent = `命中 ${list.length} 条，显示前 ${sliced.length} 条。`;

    for(const {rec, score} of sliced){
      const div = document.createElement("div");
      div.className = "result";

      const title = normalizeStr(rec.title);
      const year = safeYear(rec.year);
      const patterns = (rec.nlp && rec.nlp.pattern_markers) ? rec.nlp.pattern_markers : [];
      const phrases = (rec.nlp && rec.nlp.phrases) ? rec.nlp.phrases : [];

      const scoreText = (getMode()==="fuzzy") ? `相关度: ${(1-score).toFixed(3)}` : "精确匹配";
      div.innerHTML = `
        <div class="result-top">
          <div>
            <div class="result-title">${escapeHtml(title)}</div>
            <div class="hint mono">${escapeHtml(rec.id || "")} · ${escapeHtml(scoreText)}</div>
            <div class="badges">
              ${year ? `<span class="badge badge-year">${year}</span>` : ``}
              ${patterns.slice(0,2).map(p=>`<span class="badge badge-pattern">${escapeHtml(p)}</span>`).join("")}
              ${phrases.slice(0,3).map(p=>`<span class="badge badge-phrase">${escapeHtml(p)}</span>`).join("")}
            </div>
          </div>
        </div>
      `;
      resultsEl.appendChild(div);
    }
    updateCharts(sliced.map(x=>x.rec));
    lastSearch.results = sliced.map(x=>x.rec);
  }
  function aggregateYears(recs){
    const m = new Map();
    for(const r of recs){
      const y = safeYear(r.year);
      if(!y) continue;
      m.set(y, (m.get(y)||0)+1);
    }
    const years = Array.from(m.keys()).sort((a,b)=>a-b);
    return { labels: years.map(String), values: years.map(y=>m.get(y)) };
  }
  function aggregatePatterns(recs){
    const m = new Map();
    for(const r of recs){
      const ps = (r.nlp && r.nlp.pattern_markers) ? r.nlp.pattern_markers : [];
      const p = ps[0] || "OTHER";
      m.set(p, (m.get(p)||0)+1);
    }
    const arr = Array.from(m.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 12);
    return { labels: arr.map(x=>x[0]), values: arr.map(x=>x[1]) };
  }
  function updateCharts(recs){
    const yAgg = aggregateYears(recs);
    const pAgg = aggregatePatterns(recs);

    const ctxY = document.getElementById("chartYears");
    if(charts.years) charts.years.destroy();
    charts.years = new Chart(ctxY, {
      type: "bar",
      data: { labels: yAgg.labels, datasets: [{ label: "项目数", data: yAgg.values }] },
      options: { responsive:true, plugins:{ legend:{ display:false } } }
    });

    const ctxP = document.getElementById("chartPatterns");
    if(charts.patterns) charts.patterns.destroy();
    charts.patterns = new Chart(ctxP, {
      type: "bar",
      data: { labels: pAgg.labels, datasets: [{ label: "项目数", data: pAgg.values }] },
      options: { responsive:true, plugins:{ legend:{ display:false } }, indexAxis:"y" }
    });

    lastSearch.charts.years = yAgg;
    lastSearch.charts.patterns = pAgg;
  }

  async function vectorSearch(queryVector, topK, candidates){
    if(vectorWorkerReady){
      const payload = {
        queryVector: Array.from(queryVector),
        topK: topK,
        candidates: candidates && candidates.length ? candidates : null
      };
      const res = await workerCall("search", payload);
      return res.results || [];
    }
    const ids = candidates && candidates.length ? candidates : vectorState.metadata.map((_, idx)=>idx);
    const results = [];
    for(const idx of ids){
      const sim = cosineQueryLocal(queryVector, idx);
      if(sim != null) results.push({ index: idx, score: sim });
    }
    results.sort((a,b)=>b.score - a.score);
    return results.slice(0, topK);
  }
  async function buildGraphEdges(indices, threshold, edgeLimit){
    if(vectorWorkerReady){
      const payload = { indices, threshold, edgeLimit };
      const res = await workerCall("edges", payload);
      return res.edges || [];
    }
    const edges = [];
    for(let i=0;i<indices.length;i++){
      for(let j=i+1;j<indices.length;j++){
        const sim = cosineLocal(indices[i], indices[j]);
        if(sim == null) continue;
        if(sim >= threshold) edges.push({ source:i, target:j, weight: sim });
      }
    }
    edges.sort((a,b)=>b.weight - a.weight);
    return edges.slice(0, edgeLimit);
  }
  function renderGraphOverview(){
    if(!precomputedGraph){
      graphOverview.textContent = "尚未加载 graph.json";
      graphClusters.innerHTML = "";
      graphCooccurrence.innerHTML = "";
      if(graphCharts.year){ graphCharts.year.destroy(); graphCharts.year = null; }
      return;
    }
    const yearStats = precomputedGraph.yearStats || {};
    const years = Object.keys(yearStats).sort((a,b)=>Number(a)-Number(b));
    const values = years.map(y=>yearStats[y].count || 0);
    if(graphCharts.year) graphCharts.year.destroy();
    if(graphYearTrend){
      graphCharts.year = new Chart(graphYearTrend, {
        type: "line",
        data: { labels: years, datasets: [{ label: "项目数", data: values, fill:true }] },
        options: { responsive:true, plugins:{ legend:{ display:false } } }
      });
    }
    const clusters = precomputedGraph.clusters || [];
    const topClusters = [...clusters].sort((a,b)=>(b.projectIds?.length||0) - (a.projectIds?.length||0)).slice(0, 8);
    graphClusters.innerHTML = topClusters.length ? "" : "<div class=\"hint\">暂无聚类信息</div>";
    for(const c of topClusters){
      const div = document.createElement("div");
      div.className = "cluster-card";
      div.innerHTML = `<strong>${escapeHtml(c.label || "未命名主题")}</strong><span>${(c.projectIds||[]).length} 个相关项目</span>`;
      graphClusters.appendChild(div);
    }
    const co = precomputedGraph.cooccurrence || {};
    const pairs = Object.entries(co).sort((a,b)=>b[1]-a[1]).slice(0, 30);
    graphCooccurrence.innerHTML = "";
    for(const [k, v] of pairs){
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = `${k} (${v})`;
      graphCooccurrence.appendChild(tag);
    }
    graphOverview.textContent = `已加载预计算图谱：${years.length} 年份 · ${clusters.length} 聚类 · ${pairs.length} 高频共现`;
  }
  function layoutGraph(nodes, edges, width, height){
    const centerX = width / 2;
    const centerY = height / 2;
    const repulsion = 3200;
    const springLength = 140;
    const springStrength = 0.012;
    const gravity = 0.0008;
    const damping = 0.88;

    for(const n of nodes){
      if(!Number.isFinite(n.x)){
        n.x = centerX + (Math.random() - 0.5) * width * 0.7;
        n.y = centerY + (Math.random() - 0.5) * height * 0.7;
        n.vx = 0;
        n.vy = 0;
      }
    }

    for(let iter=0; iter<180; iter++){
      for(const n of nodes){
        n.fx = 0;
        n.fy = 0;
      }
      for(let i=0; i<nodes.length; i++){
        for(let j=i+1; j<nodes.length; j++){
          const a = nodes[i];
          const b = nodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let dist = Math.sqrt(dx*dx + dy*dy) + 0.01;
          const force = repulsion / (dist * dist);
          dx /= dist;
          dy /= dist;
          a.fx -= force * dx;
          a.fy -= force * dy;
          b.fx += force * dx;
          b.fy += force * dy;
        }
      }
      for(const e of edges){
        const a = nodes[e.source];
        const b = nodes[e.target];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx*dx + dy*dy) + 0.01;
        const w = Math.min(1, (e.weight || 1) * 0.6);
        const stretch = (dist - springLength) * springStrength * w;
        dx /= dist;
        dy /= dist;
        a.fx += stretch * dx;
        a.fy += stretch * dy;
        b.fx -= stretch * dx;
        b.fy -= stretch * dy;
      }
      for(const n of nodes){
        n.fx += (centerX - n.x) * gravity;
        n.fy += (centerY - n.y) * gravity;
        n.vx = (n.vx + n.fx) * damping;
        n.vy = (n.vy + n.fy) * damping;
        n.x += n.vx;
        n.y += n.vy;
        n.x = Math.max(12, Math.min(width - 12, n.x));
        n.y = Math.max(12, Math.min(height - 12, n.y));
      }
    }
  }
  function colorForCategory(category){
    const palette = ["#4f8cff", "#22c55e", "#ffb020", "#ff6b6b", "#67e8f9", "#a78bfa"];
    const key = normalizeStr(category) || "其他";
    let hash = 0;
    for(let i=0;i<key.length;i++) hash = (hash + key.charCodeAt(i)) % palette.length;
    return palette[hash];
  }
  function nodeRadius(n, maxScore){
    const base = n.type === "keyword" ? 8 : 4;
    const score = n.score || 1;
    return base + (score / maxScore) * (n.type === "keyword" ? 6 : 5);
  }
  function simulateGraphStep(nodes, edges, width, height){
    const repulsion = 3600;
    const springLength = 150;
    const springStrength = 0.01;
    const gravity = 0.0006;
    const damping = 0.9;

    for(const n of nodes){
      n.fx = 0;
      n.fy = 0;
    }
    for(let i=0; i<nodes.length; i++){
      for(let j=i+1; j<nodes.length; j++){
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx*dx + dy*dy) + 0.01;
        const force = repulsion / (dist * dist);
        dx /= dist;
        dy /= dist;
        a.fx -= force * dx;
        a.fy -= force * dy;
        b.fx += force * dx;
        b.fy += force * dy;
      }
    }
      for(const e of edges){
        const a = nodes[e.source];
        const b = nodes[e.target];
        if(!a || !b) continue;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let dist = Math.sqrt(dx*dx + dy*dy) + 0.01;
        const w = Math.min(1, (e.weight || 1) * 0.6);
        const stretch = (dist - springLength) * springStrength * w;
        dx /= dist;
        dy /= dist;
        a.fx += stretch * dx;
      a.fy += stretch * dy;
      b.fx -= stretch * dx;
      b.fy -= stretch * dy;
    }
    const centerX = width / 2;
    const centerY = height / 2;
    for(const n of nodes){
      n.fx += (centerX - n.x) * gravity;
      n.fy += (centerY - n.y) * gravity;
      if(n.pinned) continue;
      n.vx = (n.vx + n.fx) * damping;
      n.vy = (n.vy + n.fy) * damping;
      n.x += n.vx;
      n.y += n.vy;
      n.x = Math.max(12, Math.min(width - 12, n.x));
      n.y = Math.max(12, Math.min(height - 12, n.y));
    }
  }
  function renderGraph(nodes, edges, threshold, options = {}){
    if(!graphCanvas) return;
    const ctx = graphCanvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    let width = graphCanvas.clientWidth || 800;
    let height = graphCanvas.clientHeight || 520;
    if(width < 10) width = 800;
    if(height < 10) height = 520;
    graphCanvas.width = Math.round(width * dpr);
    graphCanvas.height = Math.round(height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const forceLayout = options.forceLayout === true;
    if(forceLayout || nodes.some(n=>!Number.isFinite(n.x))){
      layoutGraph(nodes, edges, width, height);
    }

    ctx.clearRect(0, 0, width, height);
    const view = graphViewState.view;
    ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, view.offsetX * dpr, view.offsetY * dpr);
    const selectedIndex = graphViewState.selected ? nodes.indexOf(graphViewState.selected) : -1;
    const connected = new Set();
    if(selectedIndex >= 0){
      connected.add(selectedIndex);
      for(const e of edges){
        if(e.source === selectedIndex) connected.add(e.target);
        if(e.target === selectedIndex) connected.add(e.source);
      }
    }
    ctx.lineWidth = 1 / view.scale;
    for(const e of edges){
      const a = nodes[e.source];
      const b = nodes[e.target];
      if(!a || !b) continue;
      const isConnected = (selectedIndex >= 0) && (e.source === selectedIndex || e.target === selectedIndex);
      const hideUnrelated = (selectedIndex >= 0) && (!isConnected);
      if(hideUnrelated) continue;
      let alpha = 0.15;
      if(typeof e.weight === "number"){
        alpha = 0.12 + Math.min(0.55, Math.max(0, e.weight - threshold) * 1.6);
      }
      const edgeColor = e.type === "title"
        ? `rgba(79,140,255,${Math.max(0.08, alpha)})`
        : `rgba(255,176,32,${Math.max(0.08, alpha)})`;
      ctx.strokeStyle = isConnected ? "rgba(255,255,255,0.9)" : edgeColor;
      ctx.lineWidth = (isConnected ? 2.4 : 1) / view.scale;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const maxScore = Math.max(1, ...nodes.map(n=>n.score || 1));
    for(const n of nodes){
      if(selectedIndex >= 0 && !connected.has(nodes.indexOf(n))) continue;
      const radius = nodeRadius(n, maxScore);
      const isSelected = graphViewState.selected === n;
      ctx.fillStyle = n.type === "keyword" ? "#ffb020" : "#4f8cff";
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = isSelected ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.35)";
      ctx.stroke();
    }

    let labelNodes = [];
    if(selectedIndex >= 0){
      for(const idx of connected){
        const n = nodes[idx];
        if(n) labelNodes.push(n);
      }
    }else{
      const keywordLabels = nodes.filter(n=>n.type === "keyword");
      const titleLabels = [...nodes].filter(n=>n.type !== "keyword").sort((a,b)=>b.score - a.score).slice(0, 10);
      labelNodes = keywordLabels.concat(titleLabels);
    }
    ctx.fillStyle = "#e8eaf1";
    ctx.font = "11px ui-sans-serif, system-ui";
    for(const n of labelNodes){
      const label = normalizeStr(n.name);
      if(!label) continue;
      if(graphViewState.selected === n && n.type !== "keyword"){
        ctx.font = "14px ui-sans-serif, system-ui";
      }else if(n.type === "keyword"){
        ctx.font = "12px ui-sans-serif, system-ui";
      }else{
        ctx.font = "11px ui-sans-serif, system-ui";
      }
      if(selectedIndex >= 0){
        if(n.type === "keyword") ctx.fillStyle = "#ffe2a8";
        else ctx.fillStyle = "#cfe0ff";
      }else{
        ctx.fillStyle = "#e8eaf1";
      }
      ctx.fillText(label, n.x + 6, n.y - 6);
    }
  }
  function pickNodeAt(nodes, x, y){
    if(!nodes || nodes.length === 0) return null;
    const maxScore = Math.max(1, ...nodes.map(n=>n.score || 1));
    for(let i=nodes.length - 1; i>=0; i--){
      const n = nodes[i];
      const radius = nodeRadius(n, maxScore) + 4;
      const dx = x - n.x;
      const dy = y - n.y;
      if(dx * dx + dy * dy <= radius * radius) return n;
    }
    return null;
  }
  function renderGraphTop(nodes){
    graphTop.innerHTML = "";
    const top = [...nodes].filter(n=>n.type !== "keyword").sort((a,b)=>b.score - a.score).slice(0, 12);
    for(const n of top){
      const div = document.createElement("div");
      div.className = "result";
      div.innerHTML = `
        <div class="result-title">${escapeHtml(n.name)}</div>
        <div class="hint mono">${escapeHtml(n.id || "")} · ${escapeHtml(n.year || "")} · ${escapeHtml(n.category || "")}</div>
        ${n.keywords && n.keywords.length ? `<div class="badges">${n.keywords.slice(0,4).map(k=>`<span class="badge badge-phrase">${escapeHtml(k)}</span>`).join("")}</div>` : ""}
      `;
      graphTop.appendChild(div);
    }
  }
  function renderQueryClusters(results){
    if(!results || !results.length) return;
    const counts = new Map();
    const cap = Math.min(results.length, 200);
    for(let i=0;i<cap;i++){
      const meta = vectorState.metadata[results[i].index];
      if(!meta) continue;
      const tokens = meta.tokensArr || [];
      for(const t of tokens){
        if(t.length < 2) continue;
        counts.set(t, (counts.get(t) || 0) + 1);
      }
    }
    const top = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).slice(0, 10);
    if(top.length === 0) return;
    graphClusters.innerHTML = "";
    for(const [token, count] of top){
      const div = document.createElement("div");
      div.className = "cluster-card";
      div.innerHTML = `<strong>${escapeHtml(token)}</strong><span>${count} 个相关题目</span>`;
      graphClusters.appendChild(div);
    }
    graphOverview.textContent = `当前检索聚类：${top.length} 个关键词簇`;
  }
  function buildKeywordGraph(results, nodeLimit, edgeLimit, threshold){
    const maxSample = Math.min(results.length, 200);
    const keywordLimit = Math.max(6, Math.min(16, Math.floor(nodeLimit * 0.35)));
    const titleLimit = Math.max(4, nodeLimit - keywordLimit);

    const tokenCounts = new Map();
    for(let i=0;i<maxSample;i++){
      const meta = vectorState.metadata[results[i].index];
      if(!meta) continue;
      const tokens = meta.tokensArr || [];
      for(const t of tokens){
        if(t.length < 2) continue;
        tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
      }
    }
    const keywords = Array.from(tokenCounts.entries())
      .sort((a,b)=>b[1]-a[1])
      .slice(0, keywordLimit)
      .map(([token, count], idx)=>({
        key: token,
        count,
        node: {
          name: token,
          type: "keyword",
          score: count,
          index: idx
        }
      }));
    const keywordSet = new Set(keywords.map(k=>k.key));

    const titleNodes = results.slice(0, titleLimit).map((r, idx)=>{
      const meta = vectorState.metadata[r.index] || {};
      const tokens = (meta.tokensArr || []).filter(t=>keywordSet.has(t));
      const sortedTokens = tokens.sort((a,b)=>(tokenCounts.get(b)||0)-(tokenCounts.get(a)||0));
      return {
        index: r.index,
        id: meta.id,
        name: meta.name,
        year: meta.year,
        category: meta.category,
        score: r.score,
        type: "title",
        tokensSet: meta.tokensSet || new Set(meta.tokensArr || []),
        keywords: sortedTokens.slice(0, 4)
      };
    });

    const nodes = keywords.map(k=>k.node).concat(titleNodes);
    const edges = [];
    const keywordIndex = new Map();
    keywords.forEach((k, i)=>keywordIndex.set(k.key, i));

    const maxKeywordsPerTitle = 4;
    for(let i=0;i<titleNodes.length;i++){
      const titleNode = titleNodes[i];
      const tIndex = keywords.length + i;
      const tokens = titleNode.keywords || [];
      for(const token of tokens.slice(0, maxKeywordsPerTitle)){
        const kIndex = keywordIndex.get(token);
        if(kIndex == null) continue;
        edges.push({ source: kIndex, target: tIndex, weight: (tokenCounts.get(token) || 1) / maxSample, type:"keyword" });
      }
    }

    const titleEdges = [];
    for(let i=0;i<titleNodes.length;i++){
      for(let j=i+1;j<titleNodes.length;j++){
        const a = titleNodes[i];
        const b = titleNodes[j];
        const setA = a.tokensSet || new Set();
        const setB = b.tokensSet || new Set();
        let shared = 0;
        for(const t of setA){
          if(setB.has(t)) shared++;
        }
        if(shared === 0) continue;
        const union = setA.size + setB.size - shared;
        const jaccard = union ? shared / union : 0;
        if(jaccard >= threshold){
          titleEdges.push({ source: keywords.length + i, target: keywords.length + j, weight: jaccard, type:"title" });
        }
      }
    }

    const remaining = Math.max(0, edgeLimit - edges.length);
    titleEdges.sort((a,b)=>b.weight - a.weight);
    edges.push(...titleEdges.slice(0, remaining));
    return { nodes, edges };
  }
  async function buildKnowledgeGraph(){
    if(!vectorState.ready){
      setStatus(graphStatus, "请先加载向量/元数据资源", false);
      return;
    }
    const query = normalizeStr(graphQueryEl.value);
    if(!query){
      setStatus(graphStatus, "请输入检索词", false);
      return;
    }
    btnAnalyzeGraph.disabled = true;
    graphAnalysis.textContent = "";
    if(graphCharts.timeline){ graphCharts.timeline.destroy(); graphCharts.timeline = null; }
    if(graphCharts.gaps){ graphCharts.gaps.destroy(); graphCharts.gaps = null; }
    const mode = graphModeEl.value || "tfidf";
    const topK = clampInt(graphTopKEl.value, 1, 500) || 50;
    const nodeLimit = clampInt(graphNodeLimitEl.value, 5, 80) || 40;
    const edgeLimit = clampInt(graphEdgeLimitEl.value, 20, 400) || 120;
    let threshold = ensureNumber(graphThresholdEl.value, 0.2);
    threshold = Math.max(0.05, Math.min(0.6, threshold));

    const cacheKey = `${mode}::${query}::${topK}`;
    let results = graphCache.get(cacheKey) || null;
    let fallbackNote = "";

    setStatus(graphStatus, "检索中…");
    if(!results){
      const tfidfResults = tfidfSearch(query, Math.max(topK, 200));
      results = tfidfResults;
      if(mode === "embedding" || mode === "hybrid"){
        try{
          const queryVec = await getQueryEmbedding(query);
          if(queryVec && queryVec.length){
            const candidates = (mode === "hybrid") ? tfidfResults.map(r=>r.index) : null;
            const vectorResults = await vectorSearch(queryVec, topK, candidates);
            if(vectorResults && vectorResults.length) results = vectorResults;
          }
        }catch(e){
          fallbackNote = ` · Embedding 失败，已回退 TF-IDF`;
        }
      }
      graphCache.set(cacheKey, results);
    }

    if(!results || results.length === 0){
      setStatus(graphStatus, "未找到匹配记录", false);
      graphMeta.textContent = "尚未生成";
      graphTop.innerHTML = "";
      return;
    }

    renderQueryClusters(results);

    const graph = buildKeywordGraph(results, nodeLimit, edgeLimit, threshold);
    const nodes = graph.nodes;
    const edges = graph.edges;

    const avgScore = (nodes.reduce((s,n)=>s+(n.score || 0),0) / Math.max(1, nodes.length)).toFixed(2);
    const modeLabel = mode === "embedding" ? "Embedding" : (mode === "hybrid" ? "Hybrid" : "TF-IDF");
    graphMeta.textContent = `模式 ${modeLabel} · 关键词图谱 · 候选 ${results.length} 条 · 节点 ${nodes.length} 个 · 边 ${edges.length} 条 · 平均匹配 ${avgScore}${fallbackNote}`;
    renderGraphTop(nodes);
    renderGraph(nodes, edges, threshold, { forceLayout:true });
    startGraphSimulation(1200);
    setStatus(graphStatus, "知识图谱生成完成", true);
    btnAnalyzeGraph.disabled = false;
    lastGraph = { nodes, edges, threshold };
    graphViewState.selected = null;
    graphViewState.view.scale = 1;
    graphViewState.view.offsetX = 0;
    graphViewState.view.offsetY = 0;
    lastGraphSearch = { query, mode, results };
  }

  function getSelectedProvider(){ return providerEl.value; }
  function getOpenRouterModel(){
    const v = orModelEl.value;
    if(v === "__custom__"){
      const c = normalizeStr(orModelCustomEl.value);
      return c || null;
    }
    return v;
  }
  function buildRagEvidence(recs){
    const lines = [];
    for(const r of recs.slice(0, 50)){
      const y = safeYear(r.year);
      const t = normalizeStr(r.title);
      if(!t) continue;
      lines.push(`- ${y || ""}｜${t}`);
      if(lines.length >= 30) break;
    }
    return lines.join("\n");
  }
  function pickTrendBuckets(query, topM){
    if(!buckets || buckets.length === 0) return [];
    const q = normalizeStr(query);
    const scored = buckets.map(b=>{
      const text = normalizeStr(b.embedding && b.embedding.text ? b.embedding.text : "");
      let s = 0;
      if(q){
        const terms = q.split(/\s+/).filter(Boolean);
        for(const t of terms){ if(text.includes(t)) s += 1; }
      }
      return { b, s };
    }).sort((a,b)=>b.s-a.s);
    return scored.slice(0, topM).map(x=>x.b);
  }
  function buildPrompt(proposalTitle, query, evidenceRecs, trendBuckets){
    const evidenceText = buildRagEvidence(evidenceRecs);
    const trendText = trendBuckets.length
      ? trendBuckets.map(b=>`- ${b.bucket_id}｜count=${b.count}｜phrases=${(b.phrases_top||[]).slice(0,8).join("，")}`).join("\n")
      : "（无趋势桶数据）";

    return `你是国家社科基金（语言学方向）评审专家。你将基于“历史立项标题证据”对拟申报选题给出评审意见，并提出修改方向与备选题目。

硬性要求：
1) 必须引用并基于给定的【证据标题】与【趋势提示】进行判断。不得凭空编造不存在的历史立项。
2) 先输出“专家评审意见”，再输出“3-5个备选选题（可直接作为题目）”。
3) 输出中文。表达务实、具体、像评审意见。避免空泛励志。
4) 在评审意见中要覆盖：趋势与同质化风险、可能的创新点、方法与数据可行性、可见的gap、题目可改写方向。

拟申报题目：
${proposalTitle}

用户检索词（用于理解意图）：
${query}

【趋势提示（聚合）】
${trendText}

【证据标题（项目级检索 TopK）】
${evidenceText}

请严格按以下结构输出（使用清晰的小标题）：
# 专家评审意见
## 1) 相关度与趋势位置
## 2) 同质化风险与“是否做烂”
## 3) 创新空间（理论/对象/方法/数据）
## 4) 可行性与风险控制
## 5) 题目改写建议（给出3条改写原则，并给出1-2个改写示例）

# 备选选题（3-5个）
- 题目1：...
- 题目2：...
- 题目3：...
（如有更多可继续到5个）

# 使用到的证据标题（从上面的证据中选8-12条列出）
- ...`;
  }

  async function callLLM(provider, apiKey, model, temperature, prompt){
    if(!apiKey) throw new Error("缺少 API Key");
    const temp = Number(temperature);
    if(!Number.isFinite(temp)) throw new Error("temperature 非法");

    if(provider === "openrouter"){
      const url = "https://openrouter.ai/api/v1/chat/completions";
      const payload = {
        model: model,
        messages: [
          { role: "system", content: "你是严谨的学术评审助手。输出必须遵循用户给定的结构。" },
          { role: "user", content: prompt }
        ],
        temperature: temp
      };
      const res = await fetch(url, {
        method:"POST",
        headers:{
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type":"application/json"
        },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const t = await res.text();
        throw new Error(`OpenRouter 请求失败: ${res.status} ${t}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }

    if(provider === "openai"){
      const url = "https://api.openai.com/v1/chat/completions";
      const payload = {
        model: model || "gpt-4.1-mini",
        messages: [
          { role: "system", content: "你是严谨的学术评审助手。输出必须遵循用户给定的结构。" },
          { role: "user", content: prompt }
        ],
        temperature: temp
      };
      const res = await fetch(url, {
        method:"POST",
        headers:{
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type":"application/json"
        },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const t = await res.text();
        throw new Error(`OpenAI 请求失败: ${res.status} ${t}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }

    if(provider === "deepseek"){
      const url = "https://api.deepseek.com/chat/completions";
      const payload = {
        model: model || "deepseek-chat",
        messages: [
          { role: "system", content: "你是严谨的学术评审助手。输出必须遵循用户给定的结构。" },
          { role: "user", content: prompt }
        ],
        temperature: temp
      };
      const res = await fetch(url, {
        method:"POST",
        headers:{
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type":"application/json"
        },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const t = await res.text();
        throw new Error(`DeepSeek 请求失败: ${res.status} ${t}`);
      }
      const data = await res.json();
      return data.choices?.[0]?.message?.content || "";
    }

    if(provider === "anthropic"){
      const url = "https://api.anthropic.com/v1/messages";
      const payload = {
        model: model || "claude-3-5-sonnet-latest",
        max_tokens: 2000,
        temperature: temp,
        messages: [
          { role: "user", content: prompt }
        ]
      };
      const res = await fetch(url, {
        method:"POST",
        headers:{
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type":"application/json"
        },
        body: JSON.stringify(payload)
      });
      if(!res.ok){
        const t = await res.text();
        throw new Error(`Anthropic 请求失败: ${res.status} ${t}`);
      }
      const data = await res.json();
      const content = (data.content || []).map(x=>x.text).join("\n");
      return content;
    }

    throw new Error("未知 provider");
  }
  async function getQueryEmbedding(text){
    const apiKey = normalizeStr(apiKeyEl.value);
    if(!apiKey) throw new Error("缺少 API Key");
    const url = "https://openrouter.ai/api/v1/embeddings";
    const payload = {
      model: "openai/text-embedding-ada-002",
      input: text
    };
    const res = await fetch(url, {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      const t = await res.text();
      throw new Error(`Embedding 请求失败: ${res.status} ${t}`);
    }
    const data = await res.json();
    return data.data?.[0]?.embedding || [];
  }
  async function analyzeGraphWithAI(query, results){
    const apiKey = normalizeStr(apiKeyEl.value);
    if(!apiKey) throw new Error("缺少 API Key");
    const provider = getSelectedProvider();
    if(provider !== "openrouter") throw new Error("知识图谱分析仅支持 OpenRouter");
    const model = "deepseek/deepseek-chat";
    const projects = results.slice(0, 50).map(r=>{
      const meta = vectorState.metadata[r.index] || {};
      const year = meta.year || "";
      const cat = meta.category || "";
      const name = meta.name || "";
      return `${year}年 ${cat}《${name}》`;
    }).join("\n");
    const prompt = `你是国家社科基金研究专家。用户想研究"${query}"，以下是历年相关立项：

${projects}

请以JSON格式返回分析（严格遵循格式，不要有其他文字）：
{
  "themes": [
    {
      "name": "主题名称",
      "projects": ["项目索引，如0,1,2"],
      "keywords": ["核心概念"],
      "trend": "上升/稳定/下降"
    }
  ],
  "timeline": [
    {"period": "年份区间", "focus": "研究重点", "count": 数量}
  ],
  "gaps": [
    {"combination": "概念组合", "reason": "为何是空白", "lastYear": 2015, "existingCount": 3}
  ],
  "suggestions": [
    {"title": "建议选题", "angle": "创新角度", "risk": "风险提示"}
  ]
}`;
    const payload = {
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.3,
      response_format: { type: "json_object" }
    };
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method:"POST",
      headers:{
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":"application/json"
      },
      body: JSON.stringify(payload)
    });
    if(!res.ok){
      const t = await res.text();
      throw new Error(`OpenRouter 请求失败: ${res.status} ${t}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    return JSON.parse(content);
  }

  function downloadText(filename, text, mime="text/plain"){
    const blob = new Blob([text], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
  function canvasToDataURL(canvasId){
    const c = document.getElementById(canvasId);
    if(!c) return null;
    try{ return c.toDataURL("image/png"); }catch(e){ return null; }
  }
  function buildReportObject(){
    return {
      generated_at: new Date().toISOString(),
      search: {
        query: lastSearch.query,
        mode: lastSearch.mode,
        limit: lastSearch.limit,
        yearFrom: lastSearch.yearFrom,
        yearTo: lastSearch.yearTo,
        pattern: lastSearch.pattern,
        result_count: lastSearch.results.length,
        charts: lastSearch.charts
      },
      results: lastSearch.results.map(r=>({
        id: r.id, year: r.year, title: r.title,
        phrases: r.nlp?.phrases || [],
        pattern_markers: r.nlp?.pattern_markers || []
      })),
      evaluation: lastEvaluation
    };
  }
  function buildMarkdownReport(obj){
    const lines = [];
    lines.push(`# 语言学立项标题库 报告`);
    lines.push(`生成时间：${obj.generated_at}`);
    lines.push(``);
    lines.push(`## 检索参数`);
    lines.push(`- query: ${obj.search.query}`);
    lines.push(`- mode: ${obj.search.mode}`);
    lines.push(`- year: ${obj.search.yearFrom || ""} ~ ${obj.search.yearTo || ""}`);
    lines.push(`- pattern: ${obj.search.pattern || "不限"}`);
    lines.push(`- 命中并展示：${obj.search.result_count}`);
    lines.push(``);
    lines.push(`## 代表性结果（前12条）`);
    for(const r of obj.results.slice(0,12)){
      lines.push(`- ${r.year || ""}｜${r.title}（${r.id}）`);
    }
    lines.push(``);
    if(obj.evaluation && obj.evaluation.output){
      lines.push(`## 专家评审意见与备选题目`);
      lines.push(obj.evaluation.output);
      lines.push(``);
    }else{
      lines.push(`## 专家评审意见与备选题目`);
      lines.push(`（未生成）`);
      lines.push(``);
    }
    return lines.join("\n");
  }
  function buildHTMLReport(obj){
    const yearsImg = canvasToDataURL("chartYears");
    const pattImg = canvasToDataURL("chartPatterns");
    const md = buildMarkdownReport(obj)
      .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>语言学立项标题库 报告</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial; margin:24px; color:#111}
        h1,h2{margin:0 0 10px}
        .meta{color:#555; margin-bottom:16px}
        .grid{display:grid; grid-template-columns:1fr 1fr; gap:16px; margin:16px 0}
        img{max-width:100%; border:1px solid #ddd; border-radius:10px}
        pre{white-space:pre-wrap; background:#f6f6f6; padding:12px; border-radius:10px; border:1px solid #e5e5e5}
      </style></head><body>
      <h1>语言学立项标题库 报告</h1>
      <div class="meta">生成时间：${obj.generated_at}</div>
      <h2>图表</h2>
      <div class="grid">
        <div><div>年份分布</div>${yearsImg ? `<img src="${yearsImg}">` : `<div>（无图表）</div>`}</div>
        <div><div>Pattern分布</div>${pattImg ? `<img src="${pattImg}">` : `<div>（无图表）</div>`}</div>
      </div>
      <h2>文字内容</h2>
      <pre>${md}</pre>
      </body></html>`;
    return html;
  }

  function resetVectorState(){
    vectorState = {
      metadata: [],
      embeddings: null,
      norms: null,
      dim: 0,
      count: 0,
      inverted: null,
      idf: null,
      ready: false,
      source: null
    };
    vectorWorkerReady = false;
    graphCache.clear();
  }
  function finalizeVectorState(){
    if(!vectorState.metadata.length || !vectorState.embeddings) return false;
    const count = vectorState.metadata.length;
    const dim = vectorState.embeddings.length / count;
    if(!Number.isFinite(dim) || Math.floor(dim) !== dim){
      throw new Error("embeddings 与 metadata 数量不匹配");
    }
    vectorState.count = count;
    vectorState.dim = dim;
    if(!vectorState.inverted) vectorState.inverted = buildInvertedIndex(vectorState.metadata);
    if(!vectorState.idf) vectorState.idf = buildIdf(vectorState.metadata);
    if(!vectorState.norms) vectorState.norms = computeEmbeddingNorms(vectorState.embeddings, count, dim);
    ensureVectorWorker();
    const emb = vectorState.embeddings;
    workerCall("init", { embeddings: emb, dim, count }).then(()=>{
      vectorWorkerReady = true;
      vectorState.ready = true;
      btnBuildGraph.disabled = false;
      setStatus(graphStatus, "向量数据库已就绪，可生成知识图谱", true);
    }).catch((e)=>{
      vectorWorkerReady = false;
      vectorState.ready = true;
      btnBuildGraph.disabled = false;
      setStatus(graphStatus, `Worker 初始化失败：${e.message}`, false);
    });
    updateVectorAssetStatus();
    return true;
  }
  function normalizeMetadataItem(item){
    const name = normalizeStr(item.name);
    const tokensArr = normalizeTokens(item.tokens || item.name_tokens || "");
    return {
      id: item.id || item.approve_no,
      name,
      nameLower: name.toLowerCase(),
      year: item.year,
      category: item.category,
      leader: item.leader,
      org: item.org,
      tokens: item.tokens || item.name_tokens || "",
      tokensArr,
      tokensSet: new Set(tokensArr)
    };
  }
  async function loadMetadataFile(file){
    const text = await readFileAsText(file);
    const data = JSON.parse(text);
    vectorState.metadata = data.map(normalizeMetadataItem);
    vectorState.source = "compressed";
    updateVectorAssetStatus();
  }
  async function loadEmbeddingsFile(file){
    const buf = await readFileAsArrayBuffer(file);
    let bytes = new Uint8Array(buf);
    let rawBytes = bytes;
    const isGzip = file.name.endsWith(".gz") || (bytes[0] === 0x1f && bytes[1] === 0x8b);
    if(isGzip){
      rawBytes = pako.ungzip(bytes);
    }
    const floatArr = new Float32Array(rawBytes.buffer, rawBytes.byteOffset, Math.floor(rawBytes.byteLength / 4));
    vectorState.embeddings = floatArr;
    vectorState.source = "compressed";
    updateVectorAssetStatus();
  }
  async function loadVectorsJsonl(file){
    const text = await readFileAsText(file);
    const rows = parseJsonl(text);
    if(rows.length === 0) throw new Error("vectors.jsonl 为空");
    const dim = rows[0].embedding ? rows[0].embedding.length : 0;
    if(!dim) throw new Error("embedding 缺失");
    const metadata = [];
    const embeddings = new Float32Array(rows.length * dim);
    for(let i=0;i<rows.length;i++){
      const r = rows[i];
      const meta = normalizeMetadataItem({
        id: r.id || r.approve_no,
        name: r.name,
        year: r.year,
        category: r.category,
        leader: r.leader,
        org: r.org,
        name_tokens: r.name_tokens
      });
      metadata.push(meta);
      const emb = Array.isArray(r.embedding) ? r.embedding : [];
      for(let j=0;j<dim;j++){
        embeddings[i * dim + j] = emb[j] || 0;
      }
    }
    vectorState.metadata = metadata;
    vectorState.embeddings = embeddings;
    vectorState.source = "jsonl";
    updateVectorAssetStatus();
  }
  function renderAnalysisCharts(analysis){
    if(!analysis) return;
    if(graphCharts.timeline) graphCharts.timeline.destroy();
    if(graphCharts.gaps) graphCharts.gaps.destroy();
    const timeline = Array.isArray(analysis.timeline) ? analysis.timeline : [];
    if(graphTimeline && timeline.length){
      graphCharts.timeline = new Chart(graphTimeline, {
        type: "line",
        data: {
          labels: timeline.map(t=>t.period || ""),
          datasets: [{ data: timeline.map(t=>t.count || 0), fill:true }]
        },
        options: { responsive:true, plugins:{ legend:{ display:false } } }
      });
    }
    const gaps = Array.isArray(analysis.gaps) ? analysis.gaps : [];
    if(graphGaps && gaps.length){
      graphCharts.gaps = new Chart(graphGaps, {
        type: "scatter",
        data: {
          datasets: [{
            data: gaps.map(g=>({
              x: g.lastYear ? (new Date().getFullYear() - g.lastYear) : 0,
              y: g.existingCount ? (100 / g.existingCount) : 0,
              label: g.combination || ""
            }))
          }]
        },
        options: {
          plugins:{ legend:{ display:false }, tooltip:{ callbacks:{ label:(ctx)=>ctx.raw.label || "" } } },
          scales:{ x:{ title:{ display:true, text:"时间新颖度" } }, y:{ title:{ display:true, text:"概念组合稀缺度" } } }
        }
      });
    }
  }

  fileProjects.addEventListener("change", async ()=>{
    const f = fileProjects.files && fileProjects.files[0];
    if(!f){ setStatus(projectsStatus, "未加载"); return; }
    setStatus(projectsStatus, "读取中…");
    try{
      const text = await readFileAsText(f);
      const rows = parseJsonl(text);
      projects = rows.map(r=>({
        id: r.id, year: r.year, title: r.title,
        nlp: r.nlp || {}, structure: r.structure || {}
      })).filter(r=>r.id || r.title);
      setStatus(projectsStatus, `已加载 ${projects.length} 条项目`, true);
      btnBuildIndex.disabled = (projects.length === 0);
      btnSearch.disabled = true;
      btnEvaluate.disabled = true;
      indexStatus.textContent = "已加载项目数据，等待构建索引";
    }catch(e){
      setStatus(projectsStatus, `读取失败：${e.message}`, false);
      projects = [];
      btnBuildIndex.disabled = true;
    }
  });

  fileBuckets.addEventListener("change", async ()=>{
    const f = fileBuckets.files && fileBuckets.files[0];
    if(!f){ setStatus(bucketsStatus, "未加载（可选）"); return; }
    setStatus(bucketsStatus, "读取中…");
    try{
      const text = await readFileAsText(f);
      const rows = parseJsonl(text);
      buckets = rows.map(b=>({
        bucket_id: b.bucket_id, year: b.year, pattern: b.pattern, count: b.count,
        phrases_top: b.phrases_top || [], sample_titles: b.sample_titles || [],
        embedding: b.embedding || {}
      }));
      setStatus(bucketsStatus, `已加载 ${buckets.length} 个趋势桶`, true);
    }catch(e){
      setStatus(bucketsStatus, `读取失败：${e.message}`, false);
      buckets = [];
    }
  });

  fileMetadata.addEventListener("change", async ()=>{
    const f = fileMetadata.files && fileMetadata.files[0];
    if(!f){ updateVectorAssetStatus("未加载", null); return; }
    if(vectorState.source !== "compressed") resetVectorState();
    setStatus(vectorAssetStatus, "读取 metadata.json…");
    try{
      await loadMetadataFile(f);
      setStatus(vectorAssetStatus, `metadata 已加载 ${vectorState.metadata.length} 条`, true);
      if(vectorState.embeddings) finalizeVectorState();
    }catch(e){
      setStatus(vectorAssetStatus, `metadata 读取失败：${e.message}`, false);
    }
  });

  fileEmbeddings.addEventListener("change", async ()=>{
    const f = fileEmbeddings.files && fileEmbeddings.files[0];
    if(!f){ updateVectorAssetStatus("未加载", null); return; }
    if(vectorState.source !== "compressed") resetVectorState();
    setStatus(vectorAssetStatus, "读取 embeddings…");
    try{
      await loadEmbeddingsFile(f);
      setStatus(vectorAssetStatus, "embeddings 已加载", true);
      if(vectorState.metadata.length) finalizeVectorState();
    }catch(e){
      setStatus(vectorAssetStatus, `embeddings 读取失败：${e.message}`, false);
    }
  });

  fileGraph.addEventListener("change", async ()=>{
    const f = fileGraph.files && fileGraph.files[0];
    if(!f){ graphOverview.textContent = "尚未加载 graph.json"; return; }
    try{
      const text = await readFileAsText(f);
      precomputedGraph = JSON.parse(text);
      renderGraphOverview();
    }catch(e){
      graphOverview.textContent = `graph.json 读取失败：${e.message}`;
    }
  });

  fileInverted.addEventListener("change", async ()=>{
    const f = fileInverted.files && fileInverted.files[0];
    if(!f){ return; }
    try{
      const text = await readFileAsText(f);
      vectorState.inverted = JSON.parse(text);
      updateVectorAssetStatus();
    }catch(e){
      setStatus(vectorAssetStatus, `倒排索引读取失败：${e.message}`, false);
    }
  });

  fileVectors.addEventListener("change", async ()=>{
    const f = fileVectors.files && fileVectors.files[0];
    if(!f){ setStatus(vectorsStatus, "未加载（可选）"); return; }
    resetVectorState();
    setStatus(vectorsStatus, "读取 vectors.jsonl…");
    try{
      await loadVectorsJsonl(f);
      setStatus(vectorsStatus, `已加载 ${vectorState.metadata.length} 条向量记录`, true);
      finalizeVectorState();
    }catch(e){
      setStatus(vectorsStatus, `读取失败：${e.message}`, false);
      btnBuildGraph.disabled = true;
      setStatus(graphStatus, "向量数据库加载失败", false);
    }
  });

  btnBuildIndex.addEventListener("click", ()=>{
    if(projects.length === 0){ setStatus(indexStatus, "未加载项目数据", false); return; }
    setStatus(indexStatus, "构建索引中…");
    buildFuseIndex();
    buildPatternOptions();
    setStatus(indexStatus, "索引构建完成，可以检索与评判", true);
    btnSearch.disabled = false;
    btnEvaluate.disabled = false;
  });

  btnResetFilters.addEventListener("click", ()=>{
    yearFromEl.value = "";
    yearToEl.value = "";
    patternFilter.value = "";
  });

  btnSearch.addEventListener("click", ()=>{
    if(!fuse && getMode()==="fuzzy"){ setStatus(indexStatus, "请先构建索引", false); return; }
    const query = normalizeStr(q.value);
    if(!query){ resultsMeta.textContent = "请输入检索词"; resultsEl.innerHTML=""; return; }
    const mode = getMode();
    let raw = [];
    if(mode === "exact") raw = exactSearch(query);
    else raw = fuzzySearch(query);

    lastSearch.query = query;
    lastSearch.mode = mode;
    lastSearch.limit = clampInt(limitEl.value, 1, 500) || 30;
    lastSearch.yearFrom = safeYear(yearFromEl.value);
    lastSearch.yearTo = safeYear(yearToEl.value);
    lastSearch.pattern = patternFilter.value;

    renderResults(raw);
  });

  providerEl.addEventListener("change", ()=>{
    const p = getSelectedProvider();
    document.getElementById("modelField").style.display = (p === "openrouter") ? "" : "none";
    saveLocalSettings();
  });
  orModelEl.addEventListener("change", ()=>{
    if(orModelEl.value === "__custom__") orModelCustomEl.style.display = "";
    else orModelCustomEl.style.display = "none";
    saveLocalSettings();
  });

  function loadLocalSettings(){
    const saved = localStorage.getItem("ling_app_settings");
    if(!saved) return;
    try{
      const s = JSON.parse(saved);
      if(s.apiKey) apiKeyEl.value = s.apiKey;
      if(s.provider) providerEl.value = s.provider;
      if(s.orModel) orModelEl.value = s.orModel;
      if(s.orModelCustom) orModelCustomEl.value = s.orModelCustom;
      if(orModelEl.value === "__custom__") orModelCustomEl.style.display = "";
      if(s.temperature != null) temperatureEl.value = s.temperature;
      document.getElementById("modelField").style.display = (providerEl.value === "openrouter") ? "" : "none";
    }catch(e){}
  }
  function saveLocalSettings(){
    const s = {
      provider: providerEl.value,
      apiKey: apiKeyEl.value,
      orModel: orModelEl.value,
      orModelCustom: orModelCustomEl.value,
      temperature: temperatureEl.value
    };
    localStorage.setItem("ling_app_settings", JSON.stringify(s));
  }

  apiKeyEl.addEventListener("input", saveLocalSettings);
  orModelCustomEl.addEventListener("input", saveLocalSettings);
  temperatureEl.addEventListener("input", saveLocalSettings);

  btnClearStorage.addEventListener("click", ()=>{
    localStorage.removeItem("ling_app_settings");
    apiKeyEl.value = "";
    setStatus(indexStatus, "已清除本地设置", true);
  });

  function activateTab(name){
    for(const tab of tabs){
      const active = tab.dataset.tab === name;
      tab.classList.toggle("is-active", active);
      tab.setAttribute("aria-selected", active ? "true" : "false");
    }
    for(const panel of panels){
      const active = panel.dataset.tab === name;
      panel.classList.toggle("is-active", active);
    }
    if(name === "graph-view" && lastGraph){
      renderGraph(lastGraph.nodes, lastGraph.edges, lastGraph.threshold);
      startGraphSimulation(800);
    }
  }

  for(const tab of tabs){
    tab.addEventListener("click", ()=>{
      const name = tab.dataset.tab;
      if(!name) return;
      activateTab(name);
      window.location.hash = name;
    });
  }

  function getCanvasPoint(evt){
    const rect = graphCanvas.getBoundingClientRect();
    return {
      x: evt.clientX - rect.left,
      y: evt.clientY - rect.top
    };
  }
  function getWorldPoint(evt){
    const pos = getCanvasPoint(evt);
    const view = graphViewState.view;
    return {
      x: (pos.x - view.offsetX) / view.scale,
      y: (pos.y - view.offsetY) / view.scale
    };
  }
  function startGraphSimulation(durationMs){
    if(!lastGraph || !graphCanvas) return;
    const now = performance.now();
    graphSimulation.until = Math.max(graphSimulation.until || 0, now + durationMs);
    if(graphSimulation.running) return;
    graphSimulation.running = true;
    const tick = ()=>{
      if(!lastGraph) return;
      const ctx = graphCanvas.getContext("2d");
      if(!ctx) return;
      const width = graphCanvas.clientWidth || 800;
      const height = graphCanvas.clientHeight || 520;
      simulateGraphStep(lastGraph.nodes, lastGraph.edges, width, height);
      renderGraph(lastGraph.nodes, lastGraph.edges, lastGraph.threshold);
      const nowTick = performance.now();
      if(graphSimulation.dragging || nowTick < graphSimulation.until){
        graphSimulation.animId = requestAnimationFrame(tick);
      }else{
        graphSimulation.running = false;
        graphSimulation.animId = null;
      }
    };
    graphSimulation.animId = requestAnimationFrame(tick);
  }
  function bindGraphCanvas(){
    if(!graphCanvas) return;
    graphCanvas.addEventListener("pointerdown", (e)=>{
      if(!lastGraph) return;
      const pos = getWorldPoint(e);
      const node = pickNodeAt(lastGraph.nodes, pos.x, pos.y);
      if(!node){
        graphViewState.selected = null;
        graphViewState.panning = true;
        graphViewState.panStart = { x: e.clientX, y: e.clientY, ox: graphViewState.view.offsetX, oy: graphViewState.view.offsetY };
        graphViewState.pointerId = e.pointerId;
        graphCanvas.setPointerCapture(e.pointerId);
        renderGraph(lastGraph.nodes, lastGraph.edges, lastGraph.threshold);
        return;
      }
      graphViewState.selected = node;
      graphViewState.dragging = node;
      graphSimulation.dragging = true;
      node.pinned = true;
      graphViewState.pointerId = e.pointerId;
      graphCanvas.setPointerCapture(e.pointerId);
      renderGraph(lastGraph.nodes, lastGraph.edges, lastGraph.threshold);
    });
    graphCanvas.addEventListener("pointermove", (e)=>{
      if(graphViewState.pointerId !== e.pointerId) return;
      if(graphViewState.dragging){
        const pos = getWorldPoint(e);
        graphViewState.dragging.x = pos.x;
        graphViewState.dragging.y = pos.y;
        startGraphSimulation(800);
        return;
      }
      if(graphViewState.panning && graphViewState.panStart){
        const dx = e.clientX - graphViewState.panStart.x;
        const dy = e.clientY - graphViewState.panStart.y;
        graphViewState.view.offsetX = graphViewState.panStart.ox + dx;
        graphViewState.view.offsetY = graphViewState.panStart.oy + dy;
        renderGraph(lastGraph.nodes, lastGraph.edges, lastGraph.threshold);
      }
    });
    const endDrag = (e)=>{
      if(graphViewState.pointerId !== e.pointerId) return;
      if(graphViewState.dragging) graphViewState.dragging.pinned = false;
      graphViewState.dragging = null;
      graphViewState.pointerId = null;
      graphViewState.panning = false;
      graphViewState.panStart = null;
      graphSimulation.dragging = false;
      startGraphSimulation(1200);
    };
    graphCanvas.addEventListener("pointerup", endDrag);
    graphCanvas.addEventListener("pointercancel", endDrag);
    graphCanvas.addEventListener("pointerleave", endDrag);
    graphCanvas.addEventListener("wheel", (e)=>{
      if(!lastGraph) return;
      e.preventDefault();
      const view = graphViewState.view;
      const delta = e.deltaY;
      const factor = delta < 0 ? 1.1 : 0.9;
      const newScale = Math.max(view.minScale, Math.min(view.maxScale, view.scale * factor));
      const mouse = getCanvasPoint(e);
      const worldX = (mouse.x - view.offsetX) / view.scale;
      const worldY = (mouse.y - view.offsetY) / view.scale;
      view.scale = newScale;
      view.offsetX = mouse.x - worldX * view.scale;
      view.offsetY = mouse.y - worldY * view.scale;
      renderGraph(lastGraph.nodes, lastGraph.edges, lastGraph.threshold);
    }, { passive: false });
  }
  bindGraphCanvas();

  btnBuildGraph.addEventListener("click", buildKnowledgeGraph);
  btnAnalyzeGraph.addEventListener("click", async ()=>{
    if(!lastGraphSearch || !lastGraphSearch.results){
      setStatus(graphStatus, "请先生成知识图谱", false);
      return;
    }
    setStatus(graphStatus, "AI 分析中…（需要联网）");
    graphAnalysis.textContent = "";
    try{
      const analysis = await analyzeGraphWithAI(lastGraphSearch.query, lastGraphSearch.results);
      graphAnalysis.textContent = JSON.stringify(analysis, null, 2);
      renderAnalysisCharts(analysis);
      setStatus(graphStatus, "AI 分析完成", true);
      lastGraphAnalysis = analysis;
    }catch(e){
      setStatus(graphStatus, `AI 分析失败：${e.message}`, false);
      graphAnalysis.textContent = "";
    }
  });
  window.addEventListener("resize", ()=>{
    if(lastGraph){
      renderGraph(lastGraph.nodes, lastGraph.edges, lastGraph.threshold);
    }
  });

  btnEvaluate.addEventListener("click", async ()=>{
    const proposalTitle = normalizeStr(proposalTitleEl.value);
    if(!proposalTitle){ setStatus(evalStatus, "请输入拟申报题目", false); return; }
    const query = normalizeStr(proposalQueryEl.value) || proposalTitle;
    const provider = getSelectedProvider();
    const apiKey = normalizeStr(apiKeyEl.value);
    const temperature = temperatureEl.value;
    const k = clampInt(ragKEl.value, 1, 200) || 30;
    const m = clampInt(ragMEl.value, 1, 50) || 8;

    let raw = [];
    if(fuse){ raw = fuse.search(query); }
    else { raw = exactSearch(query); }

    const evidence = raw.slice(0, k).map(r=>projects[r.item.__idx]);
    const trend = pickTrendBuckets(query, m);
    const prompt = buildPrompt(proposalTitle, query, evidence, trend);

    let model = null;
    if(provider === "openrouter"){
      model = getOpenRouterModel();
      if(!model){ setStatus(evalStatus, "请选择 OpenRouter 模型", false); return; }
    }

    setStatus(evalStatus, "调用模型中…（需要联网）");
    llmOutput.textContent = "";
    try{
      const output = await callLLM(provider, apiKey, model, temperature, prompt);
      llmOutput.textContent = output || "（模型未返回内容）";
      setStatus(evalStatus, "完成", true);

      lastEvaluation = { provider, model, proposalTitle, query, topK:k, topM:m, output };
    }catch(e){
      setStatus(evalStatus, `失败：${e.message}`, false);
      llmOutput.textContent = "";
    }
  });

  btnDownloadJSON.addEventListener("click", ()=>{
    const obj = buildReportObject();
    downloadText("report.json", JSON.stringify(obj, null, 2), "application/json");
  });
  btnDownloadMD.addEventListener("click", ()=>{
    const obj = buildReportObject();
    downloadText("report.md", buildMarkdownReport(obj), "text/markdown");
  });
  btnDownloadHTML.addEventListener("click", ()=>{
    const obj = buildReportObject();
    downloadText("report.html", buildHTMLReport(obj), "text/html");
  });
  btnExportAll.addEventListener("click", ()=>{
    const obj = buildReportObject();
    downloadText("report.html", buildHTMLReport(obj), "text/html");
  });

  loadLocalSettings();
  btnSearch.disabled = true;
  btnEvaluate.disabled = true;
  btnBuildGraph.disabled = true;
  btnAnalyzeGraph.disabled = true;
  if(window.location.hash){
    const name = window.location.hash.replace("#", "");
    if(name) activateTab(name);
  }
})();
