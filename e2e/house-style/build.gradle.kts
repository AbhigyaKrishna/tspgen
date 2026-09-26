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
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktor")
    testImplementation("io.ktor:ktor-server-test-host:$ktor")
    testImplementation("io.ktor:ktor-client-content-negotiation:$ktor")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(17)
    sourceSets.main {
        kotlin.srcDirs(
            "build/generated/tspgen/models",
            "build/generated/tspgen/server",
        )
    }
}

tasks.test {
    useJUnitPlatform()
}
