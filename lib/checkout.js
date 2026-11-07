const { getProductById } = require("./products");

/**
 * Validates checkout items against the server catalog and builds Stripe line items.
 * Clients may only send { id, quantity } — name and price come from the catalog.
 */
function buildCheckoutLineItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return { error: "Expected non-empty items array" };
  }

  const lineItems = [];

  for (const item of items) {
    const productId = item?.id ?? item?.productId;
    const product = getProductById(productId);
    if (!product) {
      return { error: `Unknown product id: ${productId}` };
    }

    // Release gate (V2): draft listings cannot be purchased.
    if ((product.release_status || "published") !== "published") {
      return { error: `This product is not available for purchase yet: ${product.name}` };
    }

    const quantityNumber = Number(item?.quantity);
    if (!Number.isInteger(quantityNumber) || quantityNumber <= 0) {
      return { error: `Invalid quantity for product: ${product.name}` };
    }

    if (
      product.type === "digital" &&
      !(product.files && Object.keys(product.files).length)
    ) {
      return { error: `This product is not available for purchase yet: ${product.name}` };
    }

    const maxQty = product.maxQuantity || 99;
    if (quantityNumber > maxQty) {
      return {
        error:
          product.type === "digital"
            ? `Digital products are limited to ${maxQty} per order: ${product.name}`
            : `Quantity exceeds maximum (${maxQty}) for product: ${product.name}`
      };
    }

    const unitAmount = Math.round(product.price * 100);
    lineItems.push({
      price_data: {
        currency: "usd",
        product_data: {
          name: product.name,
          description: product.description,
          metadata: {
            product_id: String(product.id),
            type: product.type,
            category: product.category,
            fulfillment: product.fulfillment
          }
        },
        unit_amount: unitAmount
      },
      quantity: quantityNumber
    });
  }

  return { lineItems };
}

module.exports = { buildCheckoutLineItems };
