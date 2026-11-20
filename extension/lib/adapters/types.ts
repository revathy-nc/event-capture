export interface ProductRef {
  product_id: string;
  name: string | null;
  brand: string | null;
  category: string | null;
  price: number | null;
  currency: string | null;
  in_stock: boolean | null;
}

export interface ListContext {
  list_context: string;
  rank: number | null;
  list_query: string | null;
}

export interface VariantContext {
  product_id: string;
  dimension: string;
  previous_value: string | null;
  new_value: string;
  price: number | null;
  currency: string | null;
}

export interface SiteAdapter {
  id: string;
  matches(url: URL): boolean;
  pageType(url: URL): string;
  productIdFromElement(element: Element): string | null;
  product(root: Document): ProductRef | null;
  listContext(element: Element): ListContext;
  variantFromElement(element: Element): VariantContext | null;
  /** Visible, human-readable labels for applied search filters. */
  filterLabels(root: Document): string[];
  /** URL patterns whose response bodies may be inspected (cart/wishlist). */
  bodyAllowlist: string[];
}
