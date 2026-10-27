const { planTests } = require("./ai-test-planner");

const result = planTests({
  title: "Google",
  links: [{ text: "Gmail" }],
  buttons: [{ text: "Search" }],
  inputs: [{ name: "q", type: "text" }]
});

console.log(result);