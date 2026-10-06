@service namespace S;
@get @route("/") op root(): void;
@get @route("/things/") op trailing(): void;
@get @route("/things/{id}") op read(@path id: string): void;
@get @route("/things/latest") op latest(): void;
@post @route("/things/{id}") op write(@path id: string): void;
@get @route("/separate/{id}") op separate(@path id: string): void;
@head @route("/separate/{id}") op head(@path id: string): void;
