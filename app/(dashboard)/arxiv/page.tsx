'use client'

import { ArxivView } from '@/components/arxiv/ArxivView'

export default function ArxivPage() {
  return <ArxivView tabs={['shifts', 'complaints']} title="arxiv.title" subtitle="arxiv.subtitle" />
}
