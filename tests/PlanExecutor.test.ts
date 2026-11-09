import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers/promises";

import { PlanExecutor } from "../src/runtime/PlanExecutor.js";
import type {
  PlanStep,
  PlanStepExecution,
  PlanStepStatus,
} from "../src/types/plan.js";

const executor = new PlanExecutor();

function createStep(id: string, dependsOn: string[] = []): PlanStep {
  return {
    id,
    agentId: "dev-agent",
    objective: `Executar etapa ${id}`,
    dependsOn,
  };
}

function createExecutions(
  steps: PlanStep[],
  statuses: Record<string, PlanStepStatus> = {},
): Map<string, PlanStepExecution> {
  const executions = executor.initializeExecution(steps);

  for (const [id, status] of Object.entries(statuses)) {
    const execution = executions.get(id);

    if (!execution) {
      throw new Error(`Unknown test step: ${id}`);
    }

    // Configuração direta do estado para cenários de teste.
    execution.status = status;
  }

  return executions;
}

function readyIds(
  steps: PlanStep[],
  executions: Map<string, PlanStepExecution>,
): string[] {
  return executor.getReadySteps(steps, executions).map((step) => step.id);
}

// ==========================================
// 1. VALIDAÇÃO DE PLANOS
// ==========================================

test("Deve aceitar um plano válido", () => {
  const steps = [
    createStep("A"),
    createStep("B", ["A"]),
    createStep("C", ["A", "B"]),
  ];

  assert.doesNotThrow(() => executor.validatePlan(steps));
});

test("Deve aceitar etapas independentes", () => {
  const steps = [createStep("A"), createStep("B"), createStep("C")];

  assert.doesNotThrow(() => executor.validatePlan(steps));
});

test("Deve aceitar dependências declaradas posteriormente", () => {
  const steps = [createStep("B", ["A"]), createStep("A")];

  assert.doesNotThrow(() => executor.validatePlan(steps));
});

test("Deve rejeitar IDs duplicados", () => {
  const steps = [createStep("A"), createStep("A")];

  assert.throws(() => executor.validatePlan(steps), /Duplicate step ID: A/);
});

test("Deve rejeitar dependências inexistentes", () => {
  const steps = [createStep("A"), createStep("B", ["Z"])];

  assert.throws(
    () => executor.validatePlan(steps),
    /Step B depends on non-existent step Z/,
  );
});

test("Deve rejeitar autodependência", () => {
  const steps = [createStep("A", ["A"])];

  assert.throws(
    () => executor.validatePlan(steps),
    /Cyclic dependency detected: A/,
  );
});

test("Deve rejeitar ciclos entre duas etapas", () => {
  const steps = [createStep("A", ["B"]), createStep("B", ["A"])];

  assert.throws(
    () => executor.validatePlan(steps),
    /Cyclic dependency detected/,
  );
});

test("Deve rejeitar ciclos entre três etapas", () => {
  const steps = [
    createStep("A", ["B"]),
    createStep("B", ["C"]),
    createStep("C", ["A"]),
  ];

  assert.throws(
    () => executor.validatePlan(steps),
    /Cyclic dependency detected/,
  );
});

test("Deve detectar ciclos em grupos independentes", () => {
  const steps = [
    createStep("A"),
    createStep("B", ["A"]),
    createStep("C", ["D"]),
    createStep("D", ["C"]),
  ];

  assert.throws(
    () => executor.validatePlan(steps),
    /Cyclic dependency detected/,
  );
});

test("Deve aceitar um plano vazio", () => {
  assert.doesNotThrow(() => executor.validatePlan([]));
});

// ==========================================
// 2. INICIALIZAÇÃO DAS EXECUÇÕES
// ==========================================

test("Deve inicializar todas as etapas como pending", () => {
  const steps = [createStep("A"), createStep("B", ["A"]), createStep("C")];

  const executions = executor.initializeExecution(steps);

  assert.equal(executions.size, 3);

  for (const step of steps) {
    assert.deepEqual(executions.get(step.id), {
      stepId: step.id,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      output: null,
      error: null,
    });
  }
});

test("Deve inicializar um mapa vazio para plano vazio", () => {
  const executions = executor.initializeExecution([]);

  assert.equal(executions.size, 0);
});

test("Deve criar registros independentes", () => {
  const steps = [createStep("A"), createStep("B")];

  const first = executor.initializeExecution(steps);
  const second = executor.initializeExecution(steps);

  first.get("A")!.status = "completed";

  assert.equal(first.get("A")?.status, "completed");
  assert.equal(second.get("A")?.status, "pending");
});

// ==========================================
// 3. IDENTIFICAÇÃO DE ETAPAS PRONTAS
// ==========================================

test("Deve retornar etapas sem dependências", () => {
  const steps = [createStep("A"), createStep("B"), createStep("C", ["A"])];

  const executions = createExecutions(steps);

  assert.deepEqual(readyIds(steps, executions), ["A", "B"]);
});

test("Deve liberar etapas após concluir dependências", () => {
  const steps = [
    createStep("A"),
    createStep("B", ["A"]),
    createStep("C", ["B"]),
  ];

  const executions = createExecutions(steps, {
    A: "completed",
  });

  assert.deepEqual(readyIds(steps, executions), ["B"]);
});

test("Deve aguardar todas as dependências", () => {
  const steps = [createStep("A"), createStep("B"), createStep("C", ["A", "B"])];

  const executions = createExecutions(steps, {
    A: "completed",
  });

  assert.deepEqual(readyIds(steps, executions), ["B"]);
});

test("Deve liberar etapa quando todas as dependências terminarem", () => {
  const steps = [createStep("A"), createStep("B"), createStep("C", ["A", "B"])];

  const executions = createExecutions(steps, {
    A: "completed",
    B: "completed",
  });

  assert.deepEqual(readyIds(steps, executions), ["C"]);
});

test("Não deve retornar etapas concluídas", () => {
  const steps = [createStep("A"), createStep("B")];

  const executions = createExecutions(steps, {
    A: "completed",
  });

  assert.deepEqual(readyIds(steps, executions), ["B"]);
});

test("Não deve retornar etapas em execução", () => {
  const steps = [createStep("A"), createStep("B")];

  const executions = createExecutions(steps, {
    A: "running",
  });

  assert.deepEqual(readyIds(steps, executions), ["B"]);
});

test("Não deve retornar etapas com falha", () => {
  const steps = [createStep("A"), createStep("B")];

  const executions = createExecutions(steps, {
    A: "failed",
  });

  assert.deepEqual(readyIds(steps, executions), ["B"]);
});

test("Não deve retornar etapas canceladas", () => {
  const steps = [createStep("A"), createStep("B")];

  const executions = createExecutions(steps, {
    A: "cancelled",
  });

  assert.deepEqual(readyIds(steps, executions), ["B"]);
});

test("Não deve liberar dependências de etapas com falha", () => {
  const steps = [createStep("A"), createStep("B", ["A"])];

  const executions = createExecutions(steps, {
    A: "failed",
  });

  assert.deepEqual(readyIds(steps, executions), []);
});

test("Não deve retornar etapas sem registro de execução", () => {
  const steps = [createStep("A")];

  const executions = new Map<string, PlanStepExecution>();

  assert.deepEqual(readyIds(steps, executions), []);
});

test("Não deve liberar etapa com dependência sem registro", () => {
  const steps = [createStep("A"), createStep("B", ["A"])];

  const executions = createExecutions(steps);
  executions.delete("A");

  assert.deepEqual(readyIds(steps, executions), []);
});

test("Deve retornar lista vazia quando tudo estiver concluído", () => {
  const steps = [createStep("A"), createStep("B", ["A"])];

  const executions = createExecutions(steps, {
    A: "completed",
    B: "completed",
  });

  assert.deepEqual(readyIds(steps, executions), []);
});

// ==========================================
// 4. TRANSIÇÕES DE ESTADO
// ==========================================

test("Deve permitir pending -> running", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "running");

  const execution = executions.get("A")!;

  assert.equal(execution.status, "running");
  assert.ok(execution.startedAt instanceof Date);
  assert.equal(execution.finishedAt, null);
});

test("Deve permitir running -> completed", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "running");
  executor.updateStepStatus(executions, "A", "completed");

  const execution = executions.get("A")!;

  assert.equal(execution.status, "completed");
  assert.ok(execution.startedAt instanceof Date);
  assert.ok(execution.finishedAt instanceof Date);
});

test("Deve permitir running -> failed", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "running");
  executor.updateStepStatus(executions, "A", "failed");

  assert.equal(executions.get("A")?.status, "failed");
  assert.ok(executions.get("A")?.finishedAt instanceof Date);
});

test("Deve permitir pending -> cancelled", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "cancelled");

  assert.equal(executions.get("A")?.status, "cancelled");
  assert.equal(executions.get("A")?.startedAt, null);
  assert.ok(executions.get("A")?.finishedAt instanceof Date);
});

test("Deve permitir running -> cancelled", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "running");
  executor.updateStepStatus(executions, "A", "cancelled");

  assert.equal(executions.get("A")?.status, "cancelled");
  assert.ok(executions.get("A")?.finishedAt instanceof Date);
});

test("Deve rejeitar pending -> completed", () => {
  const executions = createExecutions([createStep("A")]);

  assert.throws(
    () => executor.updateStepStatus(executions, "A", "completed"),
    /Invalid transition from pending to completed/,
  );

  assert.equal(executions.get("A")?.status, "pending");
});

test("Deve rejeitar completed -> running", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "running");
  executor.updateStepStatus(executions, "A", "completed");

  const finishedAt = executions.get("A")?.finishedAt;

  assert.throws(
    () => executor.updateStepStatus(executions, "A", "running"),
    /Invalid transition from completed to running/,
  );

  assert.equal(executions.get("A")?.status, "completed");
  assert.equal(executions.get("A")?.finishedAt, finishedAt);
});

test("Deve rejeitar failed -> running", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "running");
  executor.updateStepStatus(executions, "A", "failed");

  assert.throws(
    () => executor.updateStepStatus(executions, "A", "running"),
    /Invalid transition from failed to running/,
  );
});

test("Deve rejeitar cancelled -> running", () => {
  const executions = createExecutions([createStep("A")]);

  executor.updateStepStatus(executions, "A", "cancelled");

  assert.throws(
    () => executor.updateStepStatus(executions, "A", "running"),
    /Invalid transition from cancelled to running/,
  );
});

test("Deve rejeitar transição para o mesmo estado", () => {
  const executions = createExecutions([createStep("A")]);

  assert.throws(
    () => executor.updateStepStatus(executions, "A", "pending"),
    /Invalid transition from pending to pending/,
  );
});

test("Deve rejeitar atualização de etapa inexistente", () => {
  const executions = createExecutions([createStep("A")]);

  assert.throws(
    () => executor.updateStepStatus(executions, "Z", "running"),
    /Step Z not found in execution/,
  );
});

test("Não deve modificar timestamps em transição inválida", () => {
  const executions = createExecutions([createStep("A")]);

  assert.throws(() => executor.updateStepStatus(executions, "A", "failed"));

  assert.deepEqual(executions.get("A"), {
    stepId: "A",
    status: "pending",
    startedAt: null,
    finishedAt: null,
    output: null,
    error: null,
  });
});

// ==========================================
// 5. EXECUÇÃO CONCORRENTE
// ==========================================

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

test("Deve executar uma etapa e armazenar o resultado", async () => {
  const steps = [createStep("A")];

  const runner = async (step: PlanStep): Promise<string> => {
    return `Resultado da etapa ${step.id}`;
  };

  const executions = await executor.executePlan(steps, runner);

  assert.equal(executions.get("A")?.status, "completed");
  assert.equal(executions.get("A")?.output, "Resultado da etapa A");
  assert.equal(executions.get("A")?.error, null);
  assert.ok(executions.get("A")?.startedAt instanceof Date);
  assert.ok(executions.get("A")?.finishedAt instanceof Date);
});

test("Deve executar etapas independentes simultaneamente", async () => {
  const steps = [createStep("A"), createStep("B")];

  let active = 0;
  let maxActive = 0;

  const runner = async (step: PlanStep): Promise<string> => {
    active++;
    maxActive = Math.max(maxActive, active);

    try {
      await delay(30);
      return step.id;
    } finally {
      active--;
    }
  };

  const executions = await executor.executePlan(steps, runner, 2);

  assert.equal(maxActive, 2);
  assert.equal(executions.get("A")?.status, "completed");
  assert.equal(executions.get("B")?.status, "completed");
});

test("Deve respeitar maxConcurrency", async () => {
  const steps = Array.from({ length: 6 }, (_, i) => createStep(`S${i}`));

  let active = 0;
  let maxActive = 0;

  const runner = async (step: PlanStep): Promise<string> => {
    active++;
    maxActive = Math.max(maxActive, active);

    try {
      await delay(15);
      return step.id;
    } finally {
      active--;
    }
  };

  const executions = await executor.executePlan(steps, runner, 2);

  assert.equal(maxActive, 2);
  assert.ok(
    [...executions.values()].every(
      (execution) => execution.status === "completed",
    ),
  );
});

test("Deve executar sequencialmente com maxConcurrency igual a 1", async () => {
  const steps = [createStep("A"), createStep("B"), createStep("C")];

  let active = 0;
  let maxActive = 0;

  const runner = async (step: PlanStep): Promise<string> => {
    active++;
    maxActive = Math.max(maxActive, active);

    try {
      await delay(10);
      return step.id;
    } finally {
      active--;
    }
  };

  const executions = await executor.executePlan(steps, runner, 1);

  assert.equal(maxActive, 1);
  assert.ok(
    [...executions.values()].every(
      (execution) => execution.status === "completed",
    ),
  );
});

test("Deve respeitar a ordem das dependências", async () => {
  const steps = [
    createStep("A"),
    createStep("B", ["A"]),
    createStep("C", ["B"]),
  ];

  const events: string[] = [];

  const runner = async (step: PlanStep): Promise<string> => {
    events.push(`start:${step.id}`);
    await delay(10);
    events.push(`end:${step.id}`);
    return step.id;
  };

  await executor.executePlan(steps, runner, 3);

  assert.deepEqual(events, [
    "start:A",
    "end:A",
    "start:B",
    "end:B",
    "start:C",
    "end:C",
  ]);
});

test("Deve liberar uma vaga sem esperar todas as tarefas", async () => {
  const steps = [createStep("A"), createStep("B"), createStep("C", ["B"])];

  const events: string[] = [];

  const runner = async (step: PlanStep): Promise<string> => {
    events.push(`start:${step.id}`);

    await delay(step.id === "A" ? 80 : 10);

    events.push(`end:${step.id}`);
    return step.id;
  };

  await executor.executePlan(steps, runner, 2);

  assert.ok(
    events.indexOf("start:C") > events.indexOf("end:B"),
    "C deve começar depois que B terminar",
  );

  assert.ok(
    events.indexOf("start:C") < events.indexOf("end:A"),
    "C deve começar antes que A termine",
  );
});

test("Deve registrar falhas e continuar etapas independentes", async () => {
  const steps = [createStep("A"), createStep("B")];

  const runner = async (step: PlanStep): Promise<string> => {
    if (step.id === "A") {
      throw new Error("Falha simulada do agente");
    }

    return "B executada com sucesso";
  };

  const executions = await executor.executePlan(steps, runner, 2);

  assert.equal(executions.get("A")?.status, "failed");
  assert.equal(executions.get("A")?.error, "Falha simulada do agente");

  assert.equal(executions.get("B")?.status, "completed");
  assert.equal(executions.get("B")?.output, "B executada com sucesso");
});

test("Não deve executar dependentes de uma etapa com falha", async () => {
  const steps = [createStep("A"), createStep("B", ["A"]), createStep("C")];

  const called: string[] = [];

  const runner = async (step: PlanStep): Promise<string> => {
    called.push(step.id);

    if (step.id === "A") {
      throw new Error("A falhou");
    }

    return step.id;
  };

  const executions = await executor.executePlan(steps, runner, 2);

  assert.equal(executions.get("A")?.status, "failed");
  assert.equal(executions.get("B")?.status, "pending");
  assert.equal(executions.get("C")?.status, "completed");

  assert.ok(!called.includes("B"));
  assert.ok(called.includes("C"));
});

test("Deve aceitar um plano vazio sem executar o runner", async () => {
  let calls = 0;

  const runner = async (): Promise<string> => {
    calls++;
    return "resultado";
  };

  const executions = await executor.executePlan([], runner);

  assert.equal(executions.size, 0);
  assert.equal(calls, 0);
});

test("Deve rejeitar limites de concorrência inválidos", async () => {
  const steps = [createStep("A")];

  const runner = async (): Promise<string> => "resultado";

  for (const limit of [0, -1, 1.5, NaN, Infinity, -Infinity]) {
    await assert.rejects(
      executor.executePlan(steps, runner, limit),
      /Max concurrency must be a positive integer/,
    );
  }
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("Deve parar de iniciar etapas se a transição para running falhar", async () => {
  const executor = new PlanExecutor();
  const error = new Error("Falha ao iniciar B");
  const update = executor.updateStepStatus.bind(executor);
  executor.updateStepStatus = (executions, id, status) => {
    if (id === "B" && status === "running") {
      throw error;
    }
    update(executions, id, status);
  };

  const active = deferred<string>();
  const started: string[] = [];
  const plan = executor.executePlan(
    [createStep("A"), createStep("B"), createStep("C")],
    async (step) => {
      started.push(step.id);
      return step.id === "A" ? active.promise : step.id;
    },
    3,
  );
  const rejection = assert.rejects(plan, (reason) => reason === error);
  active.resolve("A");

  await rejection;
  assert.deepEqual(started, ["A"]);
});

test("Deve parar de agendar e drenar todas as etapas após uma falha interna", async () => {
  const executor = new PlanExecutor();
  const firstError = new Error("Falha ao concluir B");
  const laterError = new Error("Falha ao concluir C");
  const update = executor.updateStepStatus.bind(executor);
  executor.updateStepStatus = (executions, id, status) => {
    if (status === "completed" && id === "B") {
      throw firstError;
    }
    if (status === "completed" && id === "C") {
      throw laterError;
    }
    update(executions, id, status);
  };

  const finishFirstPair = deferred<void>();
  const finishC = deferred<void>();
  const finishD = deferred<void>();
  const started: string[] = [];
  const finished: string[] = [];
  const plan = executor.executePlan(
    [
      createStep("A"),
      createStep("B"),
      createStep("C"),
      createStep("D"),
      createStep("E"),
      createStep("F", ["A"]),
    ],
    async ({ id }) => {
      started.push(id);
      if (id === "A" || id === "B") {
        await finishFirstPair.promise;
      } else if (id === "C") {
        await finishC.promise;
      } else if (id === "D") {
        await finishD.promise;
      }
      finished.push(id);
      return id;
    },
    4,
  );
  let settled = false;
  const outcome = plan.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );

  try {
    finishFirstPair.resolve();
    await setImmediate();
    assert.deepEqual(started, ["A", "B", "C", "D"]);
    assert.deepEqual(finished, ["A", "B"]);
    assert.equal(settled, false);

    finishC.resolve();
    await setImmediate();
    assert.deepEqual(finished, ["A", "B", "C"]);
    assert.equal(settled, false);
  } finally {
    finishC.resolve();
    finishD.resolve();
  }

  assert.equal(await outcome, firstError);
  assert.deepEqual(finished, ["A", "B", "C", "D"]);
  assert.deepEqual(started, ["A", "B", "C", "D"]);
});

test("Deve drenar tarefas ativas se a busca por etapas prontas falhar", async () => {
  const executor = new PlanExecutor();
  const error = new Error("Falha ao buscar etapas prontas");
  const getReady = executor.getReadySteps.bind(executor);
  const active = deferred<string>();
  let activeFinished = false;
  let settled = false;

  executor.getReadySteps = (steps, executions) => {
    if (executions.get("A")?.status === "completed") {
      throw error;
    }
    return getReady(steps, executions);
  };
  const plan = executor.executePlan(
    [createStep("A"), createStep("B")],
    async ({ id }) => {
      if (id === "B") {
        await active.promise;
        activeFinished = true;
      }
      return id;
    },
    2,
  );
  const outcome = plan.then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );

  try {
    await setImmediate();
    assert.equal(settled, false);
  } finally {
    active.resolve("B");
  }

  assert.equal(await outcome, error);
  assert.equal(activeFinished, true);
});
