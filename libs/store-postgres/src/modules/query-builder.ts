/**
 * Shared query building logic for CRUD and search operations.
 */
export class QueryBuilder {
  static buildFilterConditions(
    filter: Record<string, unknown>,
    params: unknown[],
    paramIndex: number
  ): { conditions: string[]; newParamIndex: number } {
    const conditions: string[] = [];
    let currentParamIndex = paramIndex;

    for (const [key, value] of Object.entries(filter)) {
      if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
      ) {
        const operators = Object.keys(value);
        const isOperatorObject = operators.some((op) => op.startsWith("$"));

        if (isOperatorObject) {
          // Handle advanced operators
          for (const [operator, operatorValue] of Object.entries(value)) {
            const result = this.buildOperatorCondition(
              key,
              operator,
              operatorValue,
              params,
              currentParamIndex
            );
            if (result.condition) {
              conditions.push(result.condition);
              currentParamIndex = result.newParamIndex;
            }
          }
        } else {
          // Handle nested object queries
          conditions.push(`value @> $${currentParamIndex}::jsonb`);
          params.push(JSON.stringify({ [key]: value }));
          currentParamIndex += 1;
        }
      } else {
        // Handle simple value queries
        conditions.push(
          `value ->> $${currentParamIndex} = $${currentParamIndex + 1}`
        );
        params.push(key, String(value));
        currentParamIndex += 2;
      }
    }

    return { conditions, newParamIndex: currentParamIndex };
  }

  private static buildOperatorCondition(
    key: string,
    operator: string,
    operatorValue: unknown,
    params: unknown[],
    paramIndex: number
  ): { condition?: string; newParamIndex: number } {
    switch (operator) {
      case "$eq":
        params.push(key, String(operatorValue));
        return {
          condition: `value ->> $${paramIndex} = $${paramIndex + 1}`,
          newParamIndex: paramIndex + 2,
        };
      case "$ne":
        params.push(key, String(operatorValue));
        return {
          condition: `value ->> $${paramIndex} != $${paramIndex + 1}`,
          newParamIndex: paramIndex + 2,
        };
      case "$gt":
        params.push(key, operatorValue);
        return {
          condition: `(value ->> $${paramIndex})::numeric > $${paramIndex + 1}`,
          newParamIndex: paramIndex + 2,
        };
      case "$gte":
        params.push(key, operatorValue);
        return {
          condition: `(value ->> $${paramIndex})::numeric >= $${
            paramIndex + 1
          }`,
          newParamIndex: paramIndex + 2,
        };
      case "$lt":
        params.push(key, operatorValue);
        return {
          condition: `(value ->> $${paramIndex})::numeric < $${paramIndex + 1}`,
          newParamIndex: paramIndex + 2,
        };
      case "$lte":
        params.push(key, operatorValue);
        return {
          condition: `(value ->> $${paramIndex})::numeric <= $${
            paramIndex + 1
          }`,
          newParamIndex: paramIndex + 2,
        };
      case "$in":
        if (Array.isArray(operatorValue) && operatorValue.length > 0) {
          const placeholders = operatorValue.map(
            (_, i) => `$${paramIndex + 1 + i}`
          );
          params.push(key, ...operatorValue.map(String));
          return {
            condition: `value ->> $${paramIndex} = ANY(ARRAY[${placeholders.join(
              ","
            )}])`,
            newParamIndex: paramIndex + 1 + operatorValue.length,
          };
        }
        break;
      case "$nin":
        if (Array.isArray(operatorValue) && operatorValue.length > 0) {
          const placeholders = operatorValue.map(
            (_, i) => `$${paramIndex + 1 + i}`
          );
          params.push(key, ...operatorValue.map(String));
          return {
            condition: `value ->> $${paramIndex} != ALL(ARRAY[${placeholders.join(
              ","
            )}])`,
            newParamIndex: paramIndex + 1 + operatorValue.length,
          };
        }
        break;
      case "$exists":
        params.push(key);
        return {
          condition: operatorValue
            ? `value ? $${paramIndex}`
            : `NOT (value ? $${paramIndex})`,
          newParamIndex: paramIndex + 1,
        };
      default:
        // Unknown operator, ignore
        break;
    }
    return { newParamIndex: paramIndex };
  }
}
