// Shared vocabulary for the three kinds of product template.
//
// Kept in one place so the templates list, the Settings tab, the bill of
// materials and every order picker describe them the same way.
//
//   product      a finished good you sell to a customer
//   sub_assembly a complete part, sellable on its own, that can ALSO be
//                used as a component inside a bigger product
//   fabricated   one piece of a larger assembly, never sold on its own;
//                built and held as shop inventory
//
// The older is_sub_assembly column is still written alongside this, as
// (template_type === "fabricated"), which is exactly what that flag used
// to mean: "not a top-level orderable product".

export type TemplateType = "product" | "sub_assembly" | "fabricated";

export const TEMPLATE_TYPES: { value: TemplateType; label: string; blurb: string }[] = [
  {
    value: "product",
    label: "Product",
    blurb: "A finished good you sell to a customer.",
  },
  {
    value: "sub_assembly",
    label: "Sub-assembly",
    blurb: "A complete part you can sell on its own, and can also drop into a bigger product.",
  },
  {
    value: "fabricated",
    label: "Fabricated part",
    blurb: "One piece of a larger assembly. Never sold on its own, and never orderable.",
  },
];

// Reads a stored value safely. Anything unrecognised falls back to
// "product", which is the harmless default.
export function templateType(value: string | null | undefined): TemplateType {
  if (value === "sub_assembly" || value === "fabricated") return value;
  return "product";
}

export function templateTypeLabel(value: string | null | undefined): string {
  const found = TEMPLATE_TYPES.find((t) => t.value === templateType(value));
  return found ? found.label : "Product";
}

// A fabricated part is an internal piece, so it is the only type that never
// shows up in an order list. Sub-assemblies are sellable, so they do.
export function isOrderableType(value: string | null | undefined): boolean {
  return templateType(value) !== "fabricated";
}

// Only the two non-product types can be built to stock with a build order.
export function canBeStockable(value: string | null | undefined): boolean {
  return templateType(value) !== "product";
}
