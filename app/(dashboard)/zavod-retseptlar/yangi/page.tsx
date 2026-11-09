'use client'

import { RecipeEditor } from '@/components/production/RecipeEditor'

// ?item=<id> preselects the output item, ?from=<recipeId> prefills a copy.
export default function NewRecipePage() {
  return <RecipeEditor />
}
