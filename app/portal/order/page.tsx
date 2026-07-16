import OrderForm from "./OrderForm";

// The Products page links here with ?product=<id> to pre-select a product.
export default async function NewOrderPage({
  searchParams,
}: {
  searchParams: Promise<{ product?: string | string[] }>;
}) {
  const sp = await searchParams;
  const product = typeof sp.product === "string" ? sp.product : undefined;
  return <OrderForm initialProductId={product} />;
}
