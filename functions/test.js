const assert = require("assert");
const { Login } = require("./authentication");

async function tesLogin() {
  const result = await Login({
    password: 12345678,
    email: "aanaeemstudent@gmail.com",
  });

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.name, "Ali");
  assert.strictEqual(result.plan, "Diet plan generated");

  console.log("Async function test passed");
}

testGenerateDietPlan();