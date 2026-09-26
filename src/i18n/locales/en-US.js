export const values = Object.freeze({
  draft: 'draft',
  confirmed: 'confirmed',
  cancelled: 'cancelled',
});

export default Object.freeze({
  UNAUTHORIZED: 'Unauthorized',
  TOKEN_INVALID: 'Invalid or expired token',
  APP_FORBIDDEN: 'No access to {app}',
  ADMIN_ONLY: 'Admin only',
  NOT_FOUND: 'Not found',
  ROUTE_NOT_FOUND: 'Route not found: {method} {url}',
  BAD_REQUEST: 'Bad request',
  INTERNAL_ERROR: 'Internal server error',
  VALIDATION_FAILED: 'Validation failed',
  INVALID_VALUE: 'Invalid value for {field}',
  DUPLICATE_VALUE: 'Duplicate value',

  SETUP_ALREADY_DONE: 'Setup already done',
  EMAIL_PASSWORD_REQUIRED: 'Email and password are required',
  INVALID_CREDENTIALS: 'Invalid credentials',
  USER_INACTIVE: 'User is inactive',
  PASSWORD_TOO_SHORT: 'Password must have at least {min} characters',
  CURRENT_PASSWORD_REQUIRED: 'Current password is required',
  CURRENT_PASSWORD_INCORRECT: 'Current password is incorrect',
  SELF_DEMOTE: 'You cannot demote or deactivate yourself',
  SELF_DELETE: 'You cannot delete yourself',

  CUSTOMER_HAS_ORDERS: 'Customer has {count} order(s) and cannot be deleted',
  RECIPE_HAS_ORDERS: 'Recipe has {count} order(s) and cannot be deleted',
  INGREDIENT_IN_USE: 'Ingredient is used by {count} recipe(s) and cannot be deleted',

  PRODUCT_HAS_MOVEMENTS: 'Product has {count} stock movement(s); deactivate it instead',
  PRODUCT_NOT_FOUND: 'Product not found: {id}',
  MOVEMENTS_IMMUTABLE: 'Stock movements are immutable; post an adjustment instead',
  INVALID_MOVEMENT_TYPE: 'Invalid movement type: {type}',
  INVALID_QUANTITY: 'Quantity must be a number >= 0',
  INVOICE_NOT_DRAFT: 'Invoice is {status}; cancel it instead',
  INVOICE_NOT_CONFIRMABLE: 'Invoice is {status} and cannot be confirmed',
  INVOICE_NO_ITEMS: 'Invoice has no items',
  INVOICE_ALREADY_CANCELLED: 'Invoice already cancelled',
});
