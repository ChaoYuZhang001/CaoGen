import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.intellij.platform") version "2.2.1"
    kotlin("jvm") version "2.0.21"
}

group = "com.caogen"
version = "0.0.1"

// 默认对齐本机可验的 IntelliJ IDEA 2023.2.2；发布新版本时可用环境变量覆盖。
val intellijPlatformVersion = providers.environmentVariable("CAOGEN_JETBRAINS_PLATFORM_VERSION").orElse("2023.2.2")

kotlin {
    jvmToolchain(17)
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

java {
    // IntelliJ 2023.2 运行在 JBR17，插件字节码必须保持 Java 17 兼容。
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

repositories {
    maven("https://maven.aliyun.com/repository/public")
    maven("https://maven.aliyun.com/repository/central")
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        intellijIdeaCommunity(intellijPlatformVersion.get())
    }
}
