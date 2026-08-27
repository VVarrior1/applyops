import { Badge } from "@/components/ui/badge";

/**
 * The `F-014`-style citation chips, rendered the same way the Tailor and
 * Suggestions tabs render them. They are the whole point of the citation
 * contract: a claim the user can trace back to a line of their own profile.
 */
export function FactChips({ ids }: { ids: readonly string[] }) {
  if (ids.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <Badge key={id} variant="outline" className="font-mono text-[10px]">
          {id}
        </Badge>
      ))}
    </div>
  );
}
