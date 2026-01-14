let embeddings = null;
let norms = null;
let dim = 0;
let count = 0;

function computeNorms(){
  norms = new Float32Array(count);
  for(let i=0;i<count;i++){
    let sum = 0;
    const offset = i * dim;
    for(let j=0;j<dim;j++){
      const v = embeddings[offset + j];
      sum += v * v;
    }
    norms[i] = Math.sqrt(sum);
  }
}

function cosineAt(index, queryVec, queryNorm){
  const norm = norms[index] || 0;
  if(norm === 0 || queryNorm === 0) return null;
  const offset = index * dim;
  let dot = 0;
  for(let j=0;j<dim;j++){
    const q = queryVec[j] || 0;
    dot += q * embeddings[offset + j];
  }
  return dot / (norm * queryNorm);
}
function cosineBetween(indexA, indexB){
  const normA = norms[indexA] || 0;
  const normB = norms[indexB] || 0;
  if(normA === 0 || normB === 0) return null;
  const offsetA = indexA * dim;
  const offsetB = indexB * dim;
  let dot = 0;
  for(let j=0;j<dim;j++){
    dot += embeddings[offsetA + j] * embeddings[offsetB + j];
  }
  return dot / (normA * normB);
}

function topKFromScores(scores, topK){
  scores.sort((a,b)=>b.score - a.score);
  return scores.slice(0, topK);
}

self.onmessage = (e)=>{
  const data = e.data || {};
  const id = data.id;
  try{
    if(data.type === "init"){
      embeddings = data.embeddings;
      dim = data.dim;
      count = data.count;
      computeNorms();
      self.postMessage({ id, ok:true, type:"init" });
      return;
    }
    if(!embeddings) throw new Error("worker 未初始化");

    if(data.type === "search"){
      const queryVec = new Float32Array(data.queryVector || []);
      const qNorm = queryVec.length ? Math.sqrt(queryVec.reduce((s,v)=>s + v * v, 0)) : 0;
      const topK = data.topK || 50;
      const candidates = Array.isArray(data.candidates) ? data.candidates : null;
      const scores = [];
      if(candidates && candidates.length){
        for(const idx of candidates){
          const sim = cosineAt(idx, queryVec, qNorm);
          if(sim != null) scores.push({ index: idx, score: sim });
        }
      }else{
        for(let i=0;i<count;i++){
          const sim = cosineAt(i, queryVec, qNorm);
          if(sim != null) scores.push({ index: i, score: sim });
        }
      }
      const results = topKFromScores(scores, topK);
      self.postMessage({ id, ok:true, results });
      return;
    }

    if(data.type === "edges"){
      const indices = data.indices || [];
      const threshold = data.threshold || 0.82;
      const edgeLimit = data.edgeLimit || 120;
      const edges = [];
      for(let i=0;i<indices.length;i++){
        for(let j=i+1;j<indices.length;j++){
          const sim = cosineBetween(indices[i], indices[j]);
          if(sim == null) continue;
          if(sim >= threshold){
            edges.push({ source:i, target:j, weight: sim });
          }
        }
      }
      edges.sort((a,b)=>b.weight - a.weight);
      const out = edges.slice(0, edgeLimit);
      self.postMessage({ id, ok:true, edges: out });
      return;
    }

    throw new Error("未知指令");
  }catch(err){
    self.postMessage({ id, ok:false, error: err.message || String(err) });
  }
};
