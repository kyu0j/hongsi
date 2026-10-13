import type { CalendarData, SemesterDisplay, Todo } from '../../shared/types';

export const ALL_SEMESTERS_ENABLED = true;

export function resolveSemesterDisplay(display: SemesterDisplay): SemesterDisplay {
  return ALL_SEMESTERS_ENABLED ? display : 'current';
}

export function filterSemesterTodos(todos: Todo[], data: CalendarData | null, display: SemesterDisplay): Todo[] {
  if (display === 'all') return todos;
  const courses = new Set((data?.courses ?? []).filter((course) => data?.semesterDisplay !== 'all'
    || (data.currentTerm && course.term?.year === data.currentTerm.year && course.term?.semester === data.currentTerm.semester))
    .map((course) => course.id));
  return todos.filter((todo) => todo.courseId === null || courses.has(todo.courseId));
}
