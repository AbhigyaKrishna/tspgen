@service namespace S;
model Result { id: int32; }
@error model Broad { @statusCode @minValue(400) @maxValue(499) status: int32; broad: string; }
@error model Missing { @statusCode status: 404; message: string; }
@error model Fallback { reason: string; }
@get @route("/test") op read(): Result | Fallback | Broad | Missing;
