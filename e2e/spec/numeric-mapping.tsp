@service
namespace NumericMapping;

model ExactText {
  @minValue(0.1234567890123456789012345) value: decimal;
  @encode(string) text: decimal128;
  @minValue(utcDateTime.fromISO("2025-01-01T00:00:00Z")) date: utcDateTime;
  @minValue(duration.fromISO("PT1S")) elapsed: duration;
}
