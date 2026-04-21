type DifficultyBand = 'basic' | 'intermediate' | 'advanced'

export type HardcodedExercise = {
  id: string
  promptMd: string
  starterCode: string
  referenceSolution: string
  tests: string
  difficultyBand: DifficultyBand
  topics: Array<{
    id: string
    displayName: string
  }>
}

export const HARDCODED_EXERCISES: HardcodedExercise[] = [
  {
    id: 'basic-even-labels',
    promptMd: `# Even labels

Write a function named \`describe_numbers(values)\`.

- It should take a list of integers.
- Return a new list of strings.
- Each string should look like \`"4 is even"\` or \`"5 is odd"\`.

Do not print inside the function. Return the list instead.`,
    starterCode: `def describe_numbers(values):
    # return a list like ["1 is odd", "2 is even"]
    pass
`,
    referenceSolution: `def describe_numbers(values):
    result = []
    for value in values:
        label = "even" if value % 2 == 0 else "odd"
        result.append(f"{value} is {label}")
    return result
`,
    tests: `from solution import describe_numbers


def test_empty_list():
    assert describe_numbers([]) == []


def test_mixed_values():
    assert describe_numbers([1, 2, 5]) == [
        "1 is odd",
        "2 is even",
        "5 is odd",
    ]
`,
    difficultyBand: 'basic',
    topics: [
      { id: 'loops', displayName: 'Loops' },
      { id: 'formatting_fstrings', displayName: 'Formatting and f-strings' },
    ],
  },
  {
    id: 'basic-word-counts',
    promptMd: `# Word counts

Write a function named \`count_words(words)\`.

- \`words\` will be a list of lowercase strings.
- Return a dictionary mapping each word to how many times it appears.

Example:

\`count_words(["red", "blue", "red"])\` should return \`{"red": 2, "blue": 1}\`.`,
    starterCode: `def count_words(words):
    counts = {}
    return counts
`,
    referenceSolution: `def count_words(words):
    counts = {}
    for word in words:
        counts[word] = counts.get(word, 0) + 1
    return counts
`,
    tests: `from solution import count_words


def test_empty_input():
    assert count_words([]) == {}


def test_repeated_words():
    assert count_words(["red", "blue", "red", "red"]) == {
        "red": 3,
        "blue": 1,
    }
`,
    difficultyBand: 'basic',
    topics: [
      { id: 'dicts', displayName: 'Dicts' },
      { id: 'functions_basic', displayName: 'Functions' },
    ],
  },
  {
    id: 'basic-fizzbuzz-lite',
    promptMd: `# FizzBuzz lite

Write a function named \`fizzbuzz_values(limit)\`.

- Return a list of values from 1 through \`limit\`.
- For multiples of 3, use \`"Fizz"\`.
- For multiples of 5, use \`"Buzz"\`.
- For multiples of both 3 and 5, use \`"FizzBuzz"\`.
- For all other numbers, keep the number itself.
`,
    starterCode: `def fizzbuzz_values(limit):
    result = []
    return result
`,
    referenceSolution: `def fizzbuzz_values(limit):
    result = []
    for value in range(1, limit + 1):
        if value % 15 == 0:
            result.append("FizzBuzz")
        elif value % 3 == 0:
            result.append("Fizz")
        elif value % 5 == 0:
            result.append("Buzz")
        else:
            result.append(value)
    return result
`,
    tests: `from solution import fizzbuzz_values


def test_small_limit():
    assert fizzbuzz_values(5) == [1, 2, "Fizz", 4, "Buzz"]


def test_fifteen():
    assert fizzbuzz_values(15)[-1] == "FizzBuzz"
`,
    difficultyBand: 'basic',
    topics: [
      { id: 'loops', displayName: 'Loops' },
      { id: 'booleans_and_conditionals', displayName: 'Booleans and Conditionals' },
    ],
  },
]
