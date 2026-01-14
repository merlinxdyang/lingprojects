#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate metadata.json, embeddings.gz, inverted-index.json, graph.json
from vectors.jsonl (local preprocessing, no network).
"""
import argparse
import gzip
import json
import math
import os
from array import array
from collections import Counter, defaultdict


def iter_jsonl(path):
  with open(path, "r", encoding="utf-8") as f:
    for line in f:
      line = line.strip()
      if not line:
        continue
      yield json.loads(line)


def normalize_tokens(text):
  if not text:
    return []
  return [t for t in str(text).strip().split() if t]


def main():
  parser = argparse.ArgumentParser(description="Preprocess vectors.jsonl into graph assets.")
  parser.add_argument("--input", required=True, help="Path to vectors.jsonl")
  parser.add_argument("--out", default=".", help="Output directory (default: .)")
  parser.add_argument("--top-tokens", type=int, default=120, help="Top tokens for cooccurrence")
  parser.add_argument("--pair-limit", type=int, default=200, help="Top cooccurrence pairs to keep")
  parser.add_argument("--per-record-tokens", type=int, default=6, help="Max tokens per record for cooccurrence")
  args = parser.parse_args()

  os.makedirs(args.out, exist_ok=True)

  metadata = []
  embeddings = array("f")
  token_df = Counter()
  tokens_per_record = []
  inverted = defaultdict(list)
  year_stats = {}
  dim = None

  for idx, rec in enumerate(iter_jsonl(args.input)):
    emb = rec.get("embedding")
    if not isinstance(emb, list):
      raise ValueError(f"Missing embedding at line {idx + 1}")
    if dim is None:
      dim = len(emb)
    if len(emb) != dim:
      raise ValueError(f"Embedding dim mismatch at line {idx + 1}: {len(emb)} != {dim}")

    embeddings.extend(emb)

    tokens = normalize_tokens(rec.get("name_tokens", ""))
    tokens_set = set(tokens)
    for t in tokens_set:
      token_df[t] += 1
      inverted[t].append(idx)
    tokens_per_record.append(tokens)

    year = str(rec.get("year", "")).strip()
    category = str(rec.get("category", "")).strip()
    if year:
      year_stats.setdefault(year, {"count": 0, "categories": {}})
      year_stats[year]["count"] += 1
      if category:
        cats = year_stats[year]["categories"]
        cats[category] = cats.get(category, 0) + 1

    metadata.append({
      "id": rec.get("id") or rec.get("approve_no") or "",
      "name": rec.get("name") or "",
      "year": rec.get("year") or "",
      "category": rec.get("category") or "",
      "leader": rec.get("leader") or "",
      "org": rec.get("org") or "",
      "tokens": rec.get("name_tokens") or ""
    })

  if dim is None:
    raise ValueError("No records found.")

  # Build cooccurrence
  top_tokens = set([t for t, _ in token_df.most_common(args.top_tokens)])
  co = Counter()
  for tokens in tokens_per_record:
    filtered = [t for t in tokens if t in top_tokens]
    seen = []
    for t in filtered:
      if t not in seen:
        seen.append(t)
    if len(seen) > args.per_record_tokens:
      seen = seen[: args.per_record_tokens]
    for i in range(len(seen)):
      for j in range(i + 1, len(seen)):
        a = seen[i]
        b = seen[j]
        key = f"{a}_{b}" if a <= b else f"{b}_{a}"
        co[key] += 1
  cooccurrence = dict(co.most_common(args.pair_limit))

  # Write metadata.json
  meta_path = os.path.join(args.out, "metadata.json")
  with open(meta_path, "w", encoding="utf-8") as f:
    json.dump(metadata, f, ensure_ascii=False)

  # Write embeddings.gz
  emb_path = os.path.join(args.out, "embeddings.gz")
  with gzip.open(emb_path, "wb") as f:
    f.write(embeddings.tobytes())

  # Write inverted-index.json
  inverted_path = os.path.join(args.out, "inverted-index.json")
  with open(inverted_path, "w", encoding="utf-8") as f:
    json.dump(inverted, f, ensure_ascii=False)

  # Build simple token clusters (top tokens)
  clusters = []
  for i, (token, count) in enumerate(token_df.most_common(20)):
    clusters.append({
      "id": i,
      "label": token,
      "projectIds": inverted.get(token, [])[:200],
      "keywords": [token]
    })

  # Write graph.json
  graph_path = os.path.join(args.out, "graph.json")
  graph = {
    "yearStats": year_stats,
    "clusters": clusters,
    "cooccurrence": cooccurrence
  }
  with open(graph_path, "w", encoding="utf-8") as f:
    json.dump(graph, f, ensure_ascii=False)

  print("Done.")
  print(f"- metadata.json: {meta_path}")
  print(f"- embeddings.gz: {emb_path}")
  print(f"- inverted-index.json: {inverted_path}")
  print(f"- graph.json: {graph_path}")
  print(f"Records: {len(metadata)}  Dim: {dim}")


if __name__ == "__main__":
  main()
