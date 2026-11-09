'use client'

import { useParams } from 'next/navigation'
import { RecipeEditor } from '@/components/production/RecipeEditor'

export default function EditRecipePage() {
  const { id } = useParams<{ id: string }>()
  return <RecipeEditor key={id} recipeId={id} />
}
