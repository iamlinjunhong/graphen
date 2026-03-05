import { useMemo } from "react";

interface CategoryBadgesProps {
  categories: string[];
  maxVisible?: number;
  isMuted?: boolean;
  emptyLabel?: string;
}

const CATEGORY_VARIANTS = [
  "is-sand",
  "is-sea",
  "is-moss",
  "is-rose",
  "is-sky",
  "is-slate",
] as const;

type CategoryVariant = (typeof CATEGORY_VARIANTS)[number];

function hashCategory(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}

function pickVariant(category: string): CategoryVariant {
  const index = hashCategory(category) % CATEGORY_VARIANTS.length;
  return CATEGORY_VARIANTS[index] ?? "is-sand";
}

export function CategoryBadges({
  categories,
  maxVisible = 2,
  isMuted = false,
  emptyLabel,
}: CategoryBadgesProps) {
  const normalizedCategories = useMemo(
    () => [...new Set(categories.map((category) => category.trim()).filter((category) => category.length > 0))],
    [categories]
  );

  if (normalizedCategories.length === 0) {
    return emptyLabel ? <span className="memory-row-empty">{emptyLabel}</span> : null;
  }

  const visible = normalizedCategories.slice(0, Math.max(0, maxVisible));
  const overflowCount = normalizedCategories.length - visible.length;

  return (
    <div className="memory-category-badges">
      {visible.map((category) => (
        <span
          key={category}
          className={`memory-category-badge ${pickVariant(category)}${isMuted ? " is-muted" : ""}`}
        >
          {category}
        </span>
      ))}
      {overflowCount > 0 ? (
        <span className={`memory-category-badge is-overflow${isMuted ? " is-muted" : ""}`}>
          +{overflowCount}
        </span>
      ) : null}
    </div>
  );
}
