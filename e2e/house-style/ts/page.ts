export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
