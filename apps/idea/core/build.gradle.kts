plugins { `java-library` }
repositories { mavenCentral() }
dependencies {
    implementation("com.google.code.gson:gson:2.11.0")
    testImplementation("org.junit.jupiter:junit-jupiter:5.11.4")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}
java { toolchain { languageVersion.set(JavaLanguageVersion.of(21)) } }
tasks.test {
    useJUnitPlatform()
    systemProperty("contracts.path", rootProject.file("../../packages/contract-tests/branch-names.json").absolutePath)
}
