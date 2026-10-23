plugins {
    java
    id("org.jetbrains.intellij.platform") version "2.19.0"
}
group = "com.gitlabworkbench"
version = "0.1.0"
repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}
dependencies {
    intellijPlatform { intellijIdeaCommunity("2026.2.3") }
    implementation(project(":core"))
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
java {
    toolchain { languageVersion.set(JavaLanguageVersion.of(25)) }
}
tasks.withType<JavaCompile>().configureEach {
    options.release.set(21)
}
intellijPlatform {
    pluginConfiguration {
        id = "com.gitlabworkbench.idea"
        name = "GitLab Workbench"
        version = project.version.toString()
        ideaVersion { sinceBuild = "243"; untilBuild = "261.*" }
    }
}
tasks.test {
    useJUnitPlatform()
    systemProperty("contracts.path", rootProject.file("../../packages/contract-tests/branch-names.json").absolutePath)
}
