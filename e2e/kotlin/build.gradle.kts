plugins {
    kotlin("jvm") version "2.4.20"
    kotlin("plugin.serialization") version "2.4.20"
}

repositories {
    mavenCentral()
}

val ktor = "3.6.0"

dependencies {
    implementation("io.ktor:ktor-server-core:$ktor")
    implementation("io.ktor:ktor-server-content-negotiation:$ktor")
    implementation("io.ktor:ktor-server-status-pages:$ktor")
    implementation("io.ktor:ktor-server-auth:$ktor")
    implementation("io.ktor:ktor-server-resources:$ktor")
    implementation("io.ktor:ktor-server-sse:$ktor")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktor")
    implementation("io.ktor:ktor-client-core:$ktor")
    implementation("io.ktor:ktor-client-content-negotiation:$ktor")
    implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
    testImplementation("io.ktor:ktor-server-test-host:$ktor")
    testImplementation("io.ktor:ktor-server-cio:$ktor")
    testImplementation("io.ktor:ktor-client-cio:$ktor")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        optIn.add("kotlin.time.ExperimentalTime")
    }
    sourceSets.main {
        kotlin.srcDirs(
            "build/generated/tspgen/models",
            "build/generated/tspgen/server",
            "build/generated/tspgen/client",
            "build/generated/tspgen-resources/models",
            "build/generated/tspgen-resources/server",
            "build/generated/tspgen-nest/models",
            "build/generated/tspgen-nest/server",
            "build/generated/versioned/v1/models",
            "build/generated/versioned/v1/server",
            "build/generated/versioned/v1/client",
            "build/generated/versioned/v2/models",
            "build/generated/versioned/v2/server",
            "build/generated/versioned/v2/client",
            "build/generated/tspgen-clash/models",
            "build/generated/tspgen-clash/server",
            "build/generated/tspgen-clash/client",
            "build/generated/tspgen-mapping/models",
            "build/generated/tspgen-mapping/server",
            "build/generated/tspgen-mapping/client",
            "build/generated/tspgen-mapping-resources/models",
            "build/generated/tspgen-mapping-resources/server",
        )
    }
}

tasks.test {
    useJUnitPlatform()
}
