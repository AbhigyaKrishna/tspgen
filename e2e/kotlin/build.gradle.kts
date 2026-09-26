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
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktor")
    implementation("io.ktor:ktor-client-core:$ktor")
    implementation("io.ktor:ktor-client-content-negotiation:$ktor")
    implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")
    testImplementation("io.ktor:ktor-server-test-host:$ktor")
    testImplementation(kotlin("test"))
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        optIn.add("kotlin.time.ExperimentalTime")
    }
    sourceSets.main {
        kotlin.srcDirs(
            "build/generated/specgen/models",
            "build/generated/specgen/server",
            "build/generated/specgen/client",
        )
    }
}

tasks.test {
    useJUnitPlatform()
}
